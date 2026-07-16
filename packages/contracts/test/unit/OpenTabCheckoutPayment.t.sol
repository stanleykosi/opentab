// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";
import {MockFeeUSDC} from "../mocks/MockUSDC.sol";
import {ReentrantPassReceiver, RejectingPassReceiver} from "../mocks/ReentrantPassReceiver.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabCheckoutPaymentTest is BaseOpenTabTest {
    bytes32 private constant SHARED_ORDER_INTENT_TYPEHASH =
        0xe61a4059100ec8b9bf8dc8dc7efc03b0cc5b0e11c22435b978393832ca943dea;
    bytes32 private constant SHARED_ORDER_PAID_TOPIC0 =
        0xfc0c20fe4986bd4a7a812e5db464f1cdf6b923c4bf93db63e0afa17be81b6f56;

    function testCanonicalConstantsMatchSharedAbiFreeze() external view {
        assertEq(checkout.ORDER_INTENT_TYPEHASH(), SHARED_ORDER_INTENT_TYPEHASH);
        assertEq(
            keccak256(
                "OrderPaid(bytes32,uint256,uint256,address,address,address,uint64,uint256,uint256,uint256,uint64,bytes32)"
            ),
            SHARED_ORDER_PAID_TOPIC0
        );
    }

    function testPayStoresExactLockedAccountingInventoryPassAndLoyalty() external {
        bytes32 orderKey = keccak256("paid-order");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 2);
        _pay(intent);

        OpenTabCheckout.Order memory order = checkout.getOrder(orderKey);
        assertEq(order.payer, payer);
        assertEq(order.recipient, recipient);
        assertEq(order.grossAmount, intent.amount);
        assertEq(order.platformFeeBps, intent.platformFeeBps);
        assertEq(order.platformFee, intent.platformFee);
        assertEq(order.quantity, 2);
        assertEq(order.refundDeadline, intent.refundDeadline);
        assertFalse(order.finalized);

        assertEq(checkout.getProduct(productId).sold, 2);
        assertEq(checkout.purchasedByWallet(productId, recipient), 2);
        assertEq(pass.balanceOf(recipient, productId), 2);
        assertEq(checkout.loyaltyPoints(merchantId, recipient), 50);
        assertEq(checkout.platformLocked(), intent.platformFee);
        assertEq(checkout.merchantLocked(merchantId), intent.amount - intent.platformFee);
        assertEq(checkout.totalLockedLiability(), intent.amount);
        assertEq(checkout.totalLiability(), intent.amount);
        assertEq(usdc.balanceOf(address(checkout)), intent.amount);
    }

    function testOrderPaidEmitsTokenAndExactIntentDigest() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("event-digest"), payer, recipient, 1);
        bytes32 expectedDigest = checkout.hashOrderIntent(intent);
        bytes32 eventSignature = SHARED_ORDER_PAID_TOPIC0;

        vm.recordLogs();
        _pay(intent);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool matched;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(checkout) || logs[i].topics[0] != eventSignature) continue;
            (
                address eventPayer,
                address eventRecipient,
                address token,
                uint64 quantity,
                uint256 amount,
                uint256 fee,
                uint256 passTokenId,
                uint64 refundDeadline,
                bytes32 intentDigest
            ) = abi.decode(
                logs[i].data, (address, address, address, uint64, uint256, uint256, uint256, uint64, bytes32)
            );
            assertEq(logs[i].topics[1], intent.orderKey);
            assertEq(uint256(logs[i].topics[2]), intent.merchantId);
            assertEq(uint256(logs[i].topics[3]), intent.productId);
            assertEq(eventPayer, intent.payer);
            assertEq(eventRecipient, intent.recipient);
            assertEq(token, intent.token);
            assertEq(quantity, intent.quantity);
            assertEq(amount, intent.amount);
            assertEq(fee, intent.platformFee);
            assertEq(passTokenId, intent.productId);
            assertEq(refundDeadline, intent.refundDeadline);
            assertEq(intentDigest, expectedDigest);
            matched = true;
        }
        assertTrue(matched);
    }

    function testOrderCannotBePaidTwice() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("replay"), payer, recipient, 1);
        _pay(intent);

        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.OrderAlreadyExists.selector, intent.orderKey), payer, intent
        );

        assertEq(checkout.getProduct(productId).sold, 1);
        assertEq(pass.balanceOf(recipient, productId), 1);
    }

    function testEip712HashMatchesCanonicalFieldEncoding() external view {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("hash"), payer, recipient, 1);
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            checkout.eip712Domain();
        bytes32 domainTypeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domainSeparator = keccak256(
            abi.encode(domainTypeHash, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
        // Every OrderIntent member is fixed width, so tuple encoding the typed
        // struct is canonical and avoids a coverage-only 16-value stack limit.
        bytes32 structHash = keccak256(abi.encode(checkout.ORDER_INTENT_TYPEHASH(), intent));
        assertEq(checkout.hashOrderIntent(intent), keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    function testIntentCannotReplayAcrossChainOrContract() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("domain"), payer, recipient, 1);
        bytes memory signature = _signIntent(intent);

        vm.chainId(block.chainid + 1);
        vm.expectRevert(OpenTabCheckout.InvalidOrderSignature.selector);
        vm.prank(payer);
        checkout.pay(intent, signature);
    }

    function testIntentSignedForDifferentContractFails() external {
        OpenTabCheckout fresh = new OpenTabCheckout(
            usdc, pass, admin, 1 days, pauser, feeManager, merchantManager, orderSigner, feeRecipient, FEE_BPS
        );
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("contract-domain"), payer, recipient, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_SIGNER_KEY, fresh.hashOrderIntent(intent));

        vm.expectRevert(OpenTabCheckout.InvalidOrderSignature.selector);
        vm.prank(payer);
        checkout.pay(intent, abi.encodePacked(r, s, v));
    }

    function testSignatureCannotAuthorizeMutatedOrderKeyRecipientOrFeePolicy() external {
        bytes32 originalKey = keccak256("immutable-intent");
        OpenTabCheckout.OrderIntent memory original = _intent(originalKey, payer, recipient, 1);
        bytes memory signature = _signIntent(original);

        OpenTabCheckout.OrderIntent memory mutated = _intent(originalKey, payer, recipient, 1);
        mutated.orderKey = keccak256("other-order-key");
        _expectPayWithSignatureRevert(
            abi.encodeWithSelector(OpenTabCheckout.InvalidOrderSignature.selector), payer, mutated, signature
        );

        mutated = _intent(originalKey, payer, recipient, 1);
        mutated.recipient = address(0xCAFE);
        _expectPayWithSignatureRevert(
            abi.encodeWithSelector(OpenTabCheckout.InvalidOrderSignature.selector), payer, mutated, signature
        );

        mutated = _intent(originalKey, payer, recipient, 1);
        mutated.platformFeeBps = 100;
        mutated.platformFee = (mutated.amount * mutated.platformFeeBps) / 10_000;
        _expectPayWithSignatureRevert(
            abi.encodeWithSelector(OpenTabCheckout.InvalidOrderSignature.selector), payer, mutated, signature
        );
    }

    function testInvalidSignerAndBoundParametersFail() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("bad-signature"), payer, recipient, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, checkout.hashOrderIntent(intent));
        vm.expectRevert(OpenTabCheckout.InvalidOrderSignature.selector);
        vm.prank(payer);
        checkout.pay(intent, abi.encodePacked(r, s, v));

        intent = _intent(keccak256("bad-amount"), payer, recipient, 1);
        intent.amount += 1;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.AmountMismatch.selector, UNIT_PRICE, UNIT_PRICE + 1), payer, intent
        );

        intent = _intent(keccak256("bad-token"), payer, recipient, 1);
        intent.token = address(0xBEEF);
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidToken.selector, address(0xBEEF)), payer, intent);

        intent = _intent(keccak256("bad-product-version"), payer, recipient, 1);
        intent.productVersion = 2;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.ProductVersionMismatch.selector, uint64(1), uint64(2)), payer, intent
        );

        intent = _intent(keccak256("bad-metadata"), payer, recipient, 1);
        intent.metadataHash = keccak256("other");
        _expectPayRevert(
            abi.encodeWithSelector(
                OpenTabCheckout.ProductMetadataMismatch.selector, keccak256("product-v1"), keccak256("other")
            ),
            payer,
            intent
        );
    }

    function testPayerQuantityExpiryAndRefundTermsAreEnforced() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("wrong-payer"), payer, recipient, 1);
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.IntentPayerMismatch.selector, payer, recipient), recipient, intent
        );

        intent = _intent(keccak256("zero-quantity"), payer, recipient, 1);
        intent.quantity = 0;
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidQuantity.selector), payer, intent);

        intent = _intent(keccak256("expired"), payer, recipient, 1);
        vm.warp(intent.validUntil + 1);
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.IntentExpired.selector, intent.validUntil), payer, intent
        );

        vm.warp(1_800_000_000);
        intent = _intent(keccak256("refund-terms"), payer, recipient, 1);
        intent.refundDeadline += 1;
        uint64 expected = intent.validUntil + REFUND_WINDOW;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.RefundTermsMismatch.selector, expected, expected + 1), payer, intent
        );
    }

    function testInventoryAndPerWalletLimitsAreAuthoritative() external {
        OpenTabCheckout.OrderIntent memory first = _intent(keccak256("limit-1"), payer, recipient, 10);
        _pay(first);

        OpenTabCheckout.OrderIntent memory second = _intent(keccak256("limit-2"), payer, recipient, 1);
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.PurchaseLimitExceeded.selector, uint64(11), uint64(10)),
            payer,
            second
        );

        vm.prank(merchantOwner);
        OpenTabCheckout.ProductInput memory input = _productInput(merchantId);
        input.maxSupply = 2;
        input.maxPerWallet = 0;
        uint256 limitedProduct = checkout.createProduct(input);
        vm.prank(merchantOwner);
        checkout.setProductActive(limitedProduct, true);

        OpenTabCheckout.OrderIntent memory soldOut = _intent(keccak256("sold-out"), payer, address(0xCAFE), 3);
        soldOut.productId = limitedProduct;
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.SoldOut.selector, limitedProduct), payer, soldOut);
        assertEq(checkout.getProduct(limitedProduct).sold, 0);
    }

    function testSignedFeeSnapshotSurvivesConfigChangeButCapAndExactMathRemainEnforced() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("fee-snapshot"), payer, recipient, 1);
        vm.prank(feeManager);
        checkout.setPlatformFeeBps(100);

        _pay(intent);
        OpenTabCheckout.Order memory order = checkout.getOrder(intent.orderKey);
        assertEq(order.platformFeeBps, FEE_BPS);
        assertEq(order.platformFee, (intent.amount * FEE_BPS) / 10_000);

        intent = _intent(keccak256("fee-over-cap"), payer, address(0xCAFE), 1);
        intent.platformFeeBps = checkout.MAX_PLATFORM_FEE_BPS() + 1;
        intent.platformFee = (intent.amount * intent.platformFeeBps) / 10_000;
        _expectPayRevert(
            abi.encodeWithSelector(
                OpenTabCheckout.FeeTooHigh.selector,
                uint256(intent.platformFeeBps),
                uint256(checkout.MAX_PLATFORM_FEE_BPS())
            ),
            payer,
            intent
        );

        intent = _intent(keccak256("fee-mismatch"), payer, address(0xBEEF), 1);
        intent.platformFeeBps = 100;
        uint256 expected = (intent.amount * 100) / 10_000;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.FeeMismatch.selector, expected, intent.platformFee), payer, intent
        );
    }

    function testFeeOnTransferTokenRevertsAtomically() external {
        MockFeeUSDC feeToken = new MockFeeUSDC();
        OpenTabPass1155 feePass = new OpenTabPass1155(admin, 1 days, address(this));
        OpenTabCheckout feeCheckout = new OpenTabCheckout(
            feeToken, feePass, admin, 1 days, pauser, feeManager, merchantManager, orderSigner, feeRecipient, FEE_BPS
        );
        feePass.bindCheckout(address(feeCheckout));
        vm.prank(merchantOwner);
        uint256 feeMerchant = feeCheckout.createMerchant(merchantPayout, keccak256("merchant"));
        OpenTabCheckout.ProductInput memory input = _productInput(feeMerchant);
        vm.prank(merchantOwner);
        uint256 feeProduct = feeCheckout.createProduct(input);
        vm.prank(merchantOwner);
        feeCheckout.setProductActive(feeProduct, true);
        feeToken.mint(payer, UNIT_PRICE);
        vm.prank(payer);
        feeToken.approve(address(feeCheckout), type(uint256).max);

        OpenTabCheckout.OrderIntent memory intent = OpenTabCheckout.OrderIntent({
            orderKey: keccak256("fee-token"),
            payer: payer,
            recipient: recipient,
            merchantId: feeMerchant,
            productId: feeProduct,
            productVersion: 1,
            token: address(feeToken),
            amount: UNIT_PRICE,
            platformFeeBps: FEE_BPS,
            platformFee: Math.mulDiv(UNIT_PRICE, FEE_BPS, 10_000),
            quantity: 1,
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 15 minutes),
            refundDeadline: uint64(block.timestamp + 15 minutes + REFUND_WINDOW),
            metadataHash: keccak256("product-v1")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_SIGNER_KEY, feeCheckout.hashOrderIntent(intent));
        uint256 expectedReceived = UNIT_PRICE - ((UNIT_PRICE * 100) / 10_000);
        vm.expectRevert(
            abi.encodeWithSelector(OpenTabCheckout.UnsupportedTokenBehavior.selector, UNIT_PRICE, expectedReceived)
        );
        vm.prank(payer);
        feeCheckout.pay(intent, abi.encodePacked(r, s, v));

        assertFalse(feeCheckout.orderExists(intent.orderKey));
        assertEq(feeCheckout.getProduct(feeProduct).sold, 0);
        assertEq(feePass.totalSupply(feeProduct), 0);
        assertEq(feeCheckout.totalLiability(), 0);
    }

    function testPassReceiverCannotReenterAccounting() external {
        ReentrantPassReceiver receiver = new ReentrantPassReceiver(checkout);
        bytes32 orderKey = keccak256("reentrant");
        receiver.arm(orderKey);
        _pay(_intent(orderKey, payer, address(receiver), 1));
        assertTrue(receiver.reentryBlocked());
        assertEq(pass.balanceOf(address(receiver), productId), 1);
        assertEq(checkout.getOrder(orderKey).grossAmount, UNIT_PRICE);
    }

    function testRejectingCodeBearingPassRecipientRevertsWholePayment() external {
        RejectingPassReceiver receiver = new RejectingPassReceiver();
        OpenTabCheckout.OrderIntent memory intent =
            _intent(keccak256("rejecting-receiver"), payer, address(receiver), 1);

        bytes memory signature = _signIntent(intent);
        vm.expectRevert();
        vm.prank(payer);
        checkout.pay(intent, signature);

        assertFalse(checkout.orderExists(intent.orderKey));
        assertEq(checkout.getProduct(productId).sold, 0);
        assertEq(checkout.totalLiability(), 0);
        assertEq(usdc.balanceOf(address(checkout)), 0);
        assertEq(pass.totalSupply(productId), 0);
    }
}
