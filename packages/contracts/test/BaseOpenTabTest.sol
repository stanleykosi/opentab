// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../src/OpenTabPass1155.sol";
import {OpenTabSplitReimbursement} from "../src/OpenTabSplitReimbursement.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

abstract contract BaseOpenTabTest is Test {
    uint256 internal constant ORDER_SIGNER_KEY = 0xA11CE;
    uint256 internal constant SPLIT_SIGNER_KEY = 0xB0B;
    uint256 internal constant UNIT_PRICE = 12_500_000;
    uint16 internal constant FEE_BPS = 250;
    uint32 internal constant REFUND_WINDOW = 7 days;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal feeManager = makeAddr("feeManager");
    address internal merchantManager = makeAddr("merchantManager");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal merchantOwner = makeAddr("merchantOwner");
    address internal merchantPayout = makeAddr("merchantPayout");
    address internal payer = makeAddr("payer");
    address internal recipient = makeAddr("recipient");
    address internal orderSigner = vm.addr(ORDER_SIGNER_KEY);
    address internal splitSigner = vm.addr(SPLIT_SIGNER_KEY);

    MockUSDC internal usdc;
    OpenTabPass1155 internal pass;
    OpenTabCheckout internal checkout;
    OpenTabSplitReimbursement internal split;
    uint256 internal merchantId;
    uint256 internal productId;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        pass = new OpenTabPass1155(admin, 1 days, address(this));
        checkout = new OpenTabCheckout(
            usdc, pass, admin, 1 days, pauser, feeManager, merchantManager, orderSigner, feeRecipient, FEE_BPS
        );
        pass.bindCheckout(address(checkout));
        split = new OpenTabSplitReimbursement(usdc, admin, 1 days, pauser, splitSigner);

        vm.prank(merchantOwner);
        merchantId = checkout.createMerchant(merchantPayout, keccak256("merchant"));
        vm.prank(merchantOwner);
        productId = checkout.createProduct(_productInput(merchantId));
        vm.prank(merchantOwner);
        checkout.setProductActive(productId, true);

        usdc.mint(payer, 1_000_000_000);
        vm.prank(payer);
        usdc.approve(address(checkout), type(uint256).max);
    }

    function _productInput(uint256 merchantId_) internal view returns (OpenTabCheckout.ProductInput memory) {
        return OpenTabCheckout.ProductInput({
            merchantId: merchantId_,
            // UNIT_PRICE is a small six-decimal test constant and cannot truncate uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            unitPrice: uint128(UNIT_PRICE),
            startsAt: uint64(block.timestamp - 1),
            endsAt: uint64(block.timestamp + 30 days),
            maxSupply: 1_000,
            maxPerWallet: 10,
            loyaltyPoints: 25,
            refundWindow: REFUND_WINDOW,
            metadataHash: keccak256("product-v1"),
            passUri: "ipfs://opentab/product-v1"
        });
    }

    function _intent(bytes32 orderKey, address payer_, address recipient_, uint64 quantity)
        internal
        view
        returns (OpenTabCheckout.OrderIntent memory intent)
    {
        uint64 validAfter = uint64(block.timestamp);
        uint64 validUntil = validAfter + 15 minutes;
        uint256 gross = UNIT_PRICE * quantity;
        intent = OpenTabCheckout.OrderIntent({
            orderKey: orderKey,
            payer: payer_,
            recipient: recipient_,
            merchantId: merchantId,
            productId: productId,
            productVersion: 1,
            token: address(usdc),
            amount: gross,
            platformFeeBps: FEE_BPS,
            platformFee: Math.mulDiv(gross, FEE_BPS, 10_000),
            quantity: quantity,
            validAfter: validAfter,
            validUntil: validUntil,
            refundDeadline: validUntil + REFUND_WINDOW,
            metadataHash: keccak256("product-v1")
        });
    }

    function _signIntent(OpenTabCheckout.OrderIntent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_SIGNER_KEY, checkout.hashOrderIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    function _pay(OpenTabCheckout.OrderIntent memory intent) internal {
        bytes memory signature = _signIntent(intent);
        vm.prank(intent.payer);
        checkout.pay(intent, signature);
    }

    function _expectPayRevert(bytes memory revertData, address caller, OpenTabCheckout.OrderIntent memory intent)
        internal
    {
        bytes memory signature = _signIntent(intent);
        vm.expectRevert(revertData);
        vm.prank(caller);
        checkout.pay(intent, signature);
    }

    function _expectPayWithSignatureRevert(
        bytes memory revertData,
        address caller,
        OpenTabCheckout.OrderIntent memory intent,
        bytes memory signature
    ) internal {
        vm.expectRevert(revertData);
        vm.prank(caller);
        checkout.pay(intent, signature);
    }

    function _splitIntent(bytes32 paymentKey, address splitPayer, address purchaser, uint256 amount)
        internal
        view
        returns (OpenTabSplitReimbursement.SplitIntent memory intent)
    {
        intent = OpenTabSplitReimbursement.SplitIntent({
            paymentKey: paymentKey,
            splitDigest: keccak256("split-1"),
            originalOrderKey: keccak256("original-order"),
            payer: splitPayer,
            beneficiary: purchaser,
            token: address(usdc),
            amount: amount,
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours),
            metadataHash: keccak256("split-metadata")
        });
    }

    function _signSplit(OpenTabSplitReimbursement.SplitIntent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SPLIT_SIGNER_KEY, split.hashSplitIntent(intent));
        return abi.encodePacked(r, s, v);
    }
}
