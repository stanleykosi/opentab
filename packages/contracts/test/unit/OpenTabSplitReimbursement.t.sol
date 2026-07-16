// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OpenTabSplitReimbursement} from "../../src/OpenTabSplitReimbursement.sol";
import {MockFeeUSDC} from "../mocks/MockUSDC.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabSplitReimbursementTest is BaseOpenTabTest {
    bytes32 private constant SHARED_SPLIT_INTENT_TYPEHASH =
        0x4ad89f55309e16f590928ac0a81cbcd202a181833d15f19873217166d6ab9e19;
    bytes32 private constant SHARED_SPLIT_REIMBURSED_TOPIC0 =
        0x9b1542461e234b6634256b0ab99e3f2ead64cf216038841919f007713ec72a87;

    address private participant;
    address private beneficiary;

    function setUp() public override {
        super.setUp();
        participant = makeAddr("splitParticipant");
        beneficiary = makeAddr("splitBeneficiary");
        usdc.mint(participant, 100_000_000);
        vm.prank(participant);
        usdc.approve(address(split), type(uint256).max);
    }

    function testCanonicalConstantsMatchSharedAbiFreeze() external view {
        assertEq(split.SPLIT_INTENT_TYPEHASH(), SHARED_SPLIT_INTENT_TYPEHASH);
        assertEq(
            keccak256("SplitReimbursed(bytes32,bytes32,bytes32,address,address,address,uint256,bytes32)"),
            SHARED_SPLIT_REIMBURSED_TOPIC0
        );
    }

    function testReimburseTransfersExactAmountConsumesKeyAndEmitsDigest() external {
        OpenTabSplitReimbursement.SplitIntent memory intent =
            _splitIntent(keccak256("split-payment"), participant, beneficiary, 25_000_000);
        bytes32 expectedDigest = split.hashSplitIntent(intent);
        bytes32 eventSignature = SHARED_SPLIT_REIMBURSED_TOPIC0;
        uint256 participantBefore = usdc.balanceOf(participant);

        vm.recordLogs();
        _reimburse(intent);

        assertEq(participantBefore - usdc.balanceOf(participant), intent.amount);
        assertEq(usdc.balanceOf(beneficiary), intent.amount);
        assertTrue(split.paymentKeyUsed(intent.paymentKey));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool matched;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(split) || logs[i].topics[0] != eventSignature) continue;
            (address eventPayer, address eventBeneficiary, address token, uint256 amount, bytes32 digest) =
                abi.decode(logs[i].data, (address, address, address, uint256, bytes32));
            assertEq(logs[i].topics[1], intent.paymentKey);
            assertEq(logs[i].topics[2], intent.splitDigest);
            assertEq(logs[i].topics[3], intent.originalOrderKey);
            assertEq(eventPayer, participant);
            assertEq(eventBeneficiary, beneficiary);
            assertEq(token, address(usdc));
            assertEq(amount, intent.amount);
            assertEq(digest, expectedDigest);
            matched = true;
        }
        assertTrue(matched);
    }

    function testEip712HashMatchesCanonicalEncoding() external view {
        OpenTabSplitReimbursement.SplitIntent memory intent =
            _splitIntent(keccak256("split-hash"), participant, beneficiary, 1_000_000);
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            split.eip712Domain();
        bytes32 domainTypeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domainSeparator = keccak256(
            abi.encode(domainTypeHash, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                split.SPLIT_INTENT_TYPEHASH(),
                intent.paymentKey,
                intent.splitDigest,
                intent.originalOrderKey,
                intent.payer,
                intent.beneficiary,
                intent.token,
                intent.amount,
                intent.validAfter,
                intent.validUntil,
                intent.metadataHash
            )
        );
        assertEq(split.hashSplitIntent(intent), keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    function testPaymentKeyCannotReplayOrBeUsedAfterRevocation() external {
        OpenTabSplitReimbursement.SplitIntent memory paid =
            _splitIntent(keccak256("replay"), participant, beneficiary, 2_000_000);
        _reimburse(paid);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.PaymentKeyConsumed.selector, paid.paymentKey),
            participant,
            paid
        );

        OpenTabSplitReimbursement.SplitIntent memory revoked =
            _splitIntent(keccak256("revoked"), participant, beneficiary, 2_000_000);
        vm.prank(splitSigner);
        split.revokePaymentKey(revoked.paymentKey, revoked.splitDigest);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.PaymentKeyConsumed.selector, revoked.paymentKey),
            participant,
            revoked
        );
    }

    function testRevocationAndPauseAreRoleBound() external {
        bytes32 paymentKey = keccak256("role-bound-revoke");
        bytes32 splitDigest = keccak256("split-digest");
        bytes32 signerRole = split.SPLIT_SIGNER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, participant, signerRole)
        );
        vm.prank(participant);
        split.revokePaymentKey(paymentKey, splitDigest);

        OpenTabSplitReimbursement.SplitIntent memory intent =
            _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        vm.prank(pauser);
        split.pause();
        _expectReimburseRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector), participant, intent);
        vm.prank(pauser);
        split.unpause();
        _reimburse(intent);
    }

    function testIntentDomainRejectsWrongChainContractAndSigner() external {
        OpenTabSplitReimbursement.SplitIntent memory intent =
            _splitIntent(keccak256("domain"), participant, beneficiary, 1_000_000);
        bytes memory signature = _signSplit(intent);

        vm.chainId(block.chainid + 1);
        _expectReimburseWithSignatureRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidSplitSignature.selector),
            participant,
            intent,
            signature
        );
        vm.chainId(block.chainid - 1);

        OpenTabSplitReimbursement other = new OpenTabSplitReimbursement(usdc, admin, 1 days, pauser, splitSigner);
        vm.expectRevert(OpenTabSplitReimbursement.InvalidSplitSignature.selector);
        vm.prank(participant);
        other.reimburse(intent, signature);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, split.hashSplitIntent(intent));
        _expectReimburseWithSignatureRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidSplitSignature.selector),
            participant,
            intent,
            abi.encodePacked(r, s, v)
        );
    }

    function testEveryCriticalIntentBoundaryIsValidated() external {
        bytes32 paymentKey = keccak256("boundaries");

        OpenTabSplitReimbursement.SplitIntent memory invalid =
            _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.paymentKey = bytes32(0);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidPaymentKey.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.splitDigest = bytes32(0);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidSplitDigest.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.originalOrderKey = bytes32(0);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidOrderKey.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.metadataHash = bytes32(0);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidMetadataHash.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.beneficiary = address(0);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.ZeroAddress.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.token = address(0xBEEF);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidToken.selector, address(0xBEEF)),
            participant,
            invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.amount = 0;
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidAmount.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.validAfter = invalid.validUntil + 1;
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.InvalidWindow.selector), participant, invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.validAfter = uint64(block.timestamp + 1);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.IntentNotYetValid.selector, invalid.validAfter),
            participant,
            invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.validAfter = uint64(block.timestamp - 2);
        invalid.validUntil = uint64(block.timestamp - 1);
        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.IntentExpired.selector, invalid.validUntil),
            participant,
            invalid
        );

        invalid = _splitIntent(paymentKey, participant, beneficiary, 1_000_000);
        invalid.validUntil = invalid.validAfter + split.MAX_INTENT_VALIDITY() + 1;
        _expectReimburseRevert(
            abi.encodeWithSelector(
                OpenTabSplitReimbursement.IntentValidityTooLong.selector, split.MAX_INTENT_VALIDITY() + 1
            ),
            participant,
            invalid
        );

        _expectReimburseRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.IntentPayerMismatch.selector, participant, beneficiary),
            beneficiary,
            _splitIntent(paymentKey, participant, beneficiary, 1_000_000)
        );
    }

    function testFeeOnTransferRevertsAtomicallyWithoutConsumingPaymentKey() external {
        MockFeeUSDC feeToken = new MockFeeUSDC();
        OpenTabSplitReimbursement feeSplit = new OpenTabSplitReimbursement(feeToken, admin, 1 days, pauser, splitSigner);
        feeToken.mint(participant, 1_000_000);
        vm.prank(participant);
        feeToken.approve(address(feeSplit), type(uint256).max);

        OpenTabSplitReimbursement.SplitIntent memory intent = OpenTabSplitReimbursement.SplitIntent({
            paymentKey: keccak256("fee-token-split"),
            splitDigest: keccak256("split"),
            originalOrderKey: keccak256("order"),
            payer: participant,
            beneficiary: beneficiary,
            token: address(feeToken),
            amount: 1_000_000,
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours),
            metadataHash: keccak256("metadata")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SPLIT_SIGNER_KEY, feeSplit.hashSplitIntent(intent));
        uint256 received = 990_000;
        vm.expectRevert(
            abi.encodeWithSelector(OpenTabSplitReimbursement.UnsupportedTokenBehavior.selector, intent.amount, received)
        );
        vm.prank(participant);
        feeSplit.reimburse(intent, abi.encodePacked(r, s, v));

        assertFalse(feeSplit.paymentKeyUsed(intent.paymentKey));
        assertEq(feeToken.balanceOf(participant), 1_000_000);
        assertEq(feeToken.balanceOf(beneficiary), 0);
    }

    function _reimburse(OpenTabSplitReimbursement.SplitIntent memory intent) internal {
        bytes memory signature = _signSplit(intent);
        vm.prank(intent.payer);
        split.reimburse(intent, signature);
    }

    function _expectReimburseRevert(
        bytes memory revertData,
        address caller,
        OpenTabSplitReimbursement.SplitIntent memory intent
    ) internal {
        bytes memory signature = _signSplit(intent);
        _expectReimburseWithSignatureRevert(revertData, caller, intent, signature);
    }

    function _expectReimburseWithSignatureRevert(
        bytes memory revertData,
        address caller,
        OpenTabSplitReimbursement.SplitIntent memory intent,
        bytes memory signature
    ) internal {
        vm.expectRevert(revertData);
        vm.prank(caller);
        split.reimburse(intent, signature);
    }
}
