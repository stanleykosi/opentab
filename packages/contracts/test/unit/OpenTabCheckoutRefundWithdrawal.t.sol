// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";
import {MockToggleFeeUSDC} from "../mocks/MockUSDC.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabCheckoutRefundWithdrawalTest is BaseOpenTabTest {
    function testPartialThenFullRefundUsesCumulativeFeeRoundingAndBurnsOnFull() external {
        bytes32 orderKey = keccak256("partial-full-refund");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 2);
        _pay(intent);

        uint256 firstRefund = 10_000_001;
        uint256 expectedFirstPlatform = (intent.platformFee * firstRefund) / intent.amount;
        vm.prank(merchantOwner);
        checkout.refund(orderKey, firstRefund);

        OpenTabCheckout.Order memory order = checkout.getOrder(orderKey);
        assertEq(order.refundedAmount, firstRefund);
        assertEq(order.platformRefunded, expectedFirstPlatform);
        assertEq(order.merchantRefunded, firstRefund - expectedFirstPlatform);
        assertEq(pass.balanceOf(recipient, productId), 2);
        uint256 expectedPointsRemoved = (50 * firstRefund) / intent.amount;
        assertEq(order.loyaltyRefunded, expectedPointsRemoved);
        assertEq(checkout.loyaltyPoints(merchantId, recipient), 50 - expectedPointsRemoved);
        assertEq(checkout.totalLiability(), intent.amount - firstRefund);

        uint256 remaining = intent.amount - firstRefund;
        vm.prank(merchantOwner);
        checkout.refund(orderKey, remaining);
        order = checkout.getOrder(orderKey);
        assertEq(order.refundedAmount, intent.amount);
        assertEq(order.platformRefunded, intent.platformFee);
        assertEq(order.merchantRefunded, intent.amount - intent.platformFee);
        assertEq(order.loyaltyRefunded, order.loyaltyAwarded);
        assertEq(pass.balanceOf(recipient, productId), 0);
        assertEq(checkout.loyaltyPoints(merchantId, recipient), 0);
        assertEq(checkout.merchantLocked(merchantId), 0);
        assertEq(checkout.platformLocked(), 0);
        assertEq(checkout.totalLiability(), 0);
        assertEq(usdc.balanceOf(payer), 1_000_000_000);
    }

    function testRefundAuthorizationBoundsAndDeadline() external {
        bytes32 orderKey = keccak256("refund-bounds");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.UnauthorizedRefund.selector, orderKey, payer));
        vm.prank(payer);
        checkout.refund(orderKey, 1);

        vm.expectRevert(OpenTabCheckout.InvalidAmount.selector);
        vm.prank(merchantOwner);
        checkout.refund(orderKey, 0);

        vm.expectRevert(
            abi.encodeWithSelector(OpenTabCheckout.RefundExceedsPaid.selector, intent.amount + 1, intent.amount)
        );
        vm.prank(merchantOwner);
        checkout.refund(orderKey, intent.amount + 1);

        vm.warp(intent.refundDeadline + 1);
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.RefundWindowClosed.selector, intent.refundDeadline));
        vm.prank(merchantOwner);
        checkout.refund(orderKey, 1);
    }

    function testAuthorizedRefundOperatorCanRefundButCannotWithdraw() external {
        address support = makeAddr("refundSupport");
        bytes32 refundRole = checkout.REFUND_OPERATOR_ROLE();
        vm.prank(admin);
        checkout.grantRole(refundRole, support);
        bytes32 orderKey = keccak256("operator-refund");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);

        vm.prank(support);
        checkout.refund(orderKey, 1_000_000);

        vm.warp(intent.refundDeadline + 1);
        checkout.finalizeOrder(orderKey);
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.UnauthorizedMerchant.selector, merchantId, support));
        vm.prank(support);
        checkout.withdrawMerchant(merchantId, 1, merchantPayout);
    }

    function testPermissionlessFinalizationMaturesExactCredits() external {
        bytes32 orderKey = keccak256("finalize");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 2);
        _pay(intent);
        vm.warp(intent.refundDeadline + 1);

        vm.prank(makeAddr("keeper"));
        checkout.finalizeOrder(orderKey);
        assertTrue(checkout.getOrder(orderKey).finalized);
        assertEq(checkout.merchantLocked(merchantId), 0);
        assertEq(checkout.platformLocked(), 0);
        assertEq(checkout.merchantCredit(merchantId), intent.amount - intent.platformFee);
        assertEq(checkout.totalMerchantCredit(), intent.amount - intent.platformFee);
        assertEq(checkout.platformCredit(), intent.platformFee);
        assertEq(checkout.totalLockedLiability(), 0);
        assertEq(checkout.totalLiability(), intent.amount);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.OrderAlreadyFinalized.selector, orderKey));
        checkout.finalizeOrder(orderKey);
    }

    function testCannotFinalizeBeforeDeadline() external {
        bytes32 orderKey = keccak256("early-finalize");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.OrderNotFinalizable.selector, intent.refundDeadline));
        checkout.finalizeOrder(orderKey);
    }

    function testMerchantWithdrawalOnlyUsesOwnMaturedCreditAndStoredPayout() external {
        bytes32 orderKey = keccak256("merchant-withdraw");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 2);
        _pay(intent);
        vm.warp(intent.refundDeadline + 1);
        checkout.finalizeOrder(orderKey);
        uint256 credit = intent.amount - intent.platformFee;

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.UnauthorizedMerchant.selector, merchantId, payer));
        vm.prank(payer);
        checkout.withdrawMerchant(merchantId, 1, merchantPayout);

        vm.expectRevert(
            abi.encodeWithSelector(OpenTabCheckout.InsufficientMerchantBalance.selector, credit + 1, credit)
        );
        vm.prank(merchantOwner);
        checkout.withdrawMerchant(merchantId, credit + 1, merchantPayout);

        uint256 payoutBefore = usdc.balanceOf(merchantPayout);
        vm.prank(merchantOwner);
        checkout.withdrawMerchant(merchantId, credit, merchantPayout);
        assertEq(usdc.balanceOf(merchantPayout) - payoutBefore, credit);
        assertEq(checkout.merchantCredit(merchantId), 0);
        assertEq(checkout.merchantWithdrawn(merchantId), credit);
        assertEq(checkout.totalLiability(), intent.platformFee);
    }

    function testMerchantWithdrawalRejectsPayoutChangedAfterPreview() external {
        bytes32 orderKey = keccak256("merchant-withdraw-payout-change");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);
        vm.warp(intent.refundDeadline + 1);
        checkout.finalizeOrder(orderKey);
        uint256 credit = intent.amount - intent.platformFee;
        address replacementPayout = makeAddr("replacementPayout");

        vm.prank(merchantOwner);
        checkout.updateMerchantPayout(merchantId, replacementPayout);
        vm.expectRevert(
            abi.encodeWithSelector(OpenTabCheckout.MerchantPayoutChanged.selector, merchantPayout, replacementPayout)
        );
        vm.prank(merchantOwner);
        checkout.withdrawMerchant(merchantId, credit, merchantPayout);

        vm.prank(merchantOwner);
        checkout.withdrawMerchant(merchantId, credit, replacementPayout);
        assertEq(usdc.balanceOf(replacementPayout), credit);
    }

    function testPlatformWithdrawalOnlyUsesMaturedPlatformCreditAndStoredRecipient() external {
        bytes32 orderKey = keccak256("platform-withdraw");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);
        vm.warp(intent.refundDeadline + 1);
        checkout.finalizeOrder(orderKey);

        address newRecipient = makeAddr("newFeeRecipient");
        vm.prank(admin);
        checkout.setFeeRecipient(newRecipient);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.UnauthorizedFeeRecipient.selector, feeRecipient));
        vm.prank(feeRecipient);
        checkout.withdrawPlatform(intent.platformFee);

        vm.prank(newRecipient);
        checkout.withdrawPlatform(intent.platformFee);
        assertEq(usdc.balanceOf(newRecipient), intent.platformFee);
        assertEq(checkout.platformCredit(), 0);
        assertEq(checkout.platformWithdrawn(), intent.platformFee);
    }

    function testFullRefundCanFinalizeToZeroAndNeverCreatesCredit() external {
        bytes32 orderKey = keccak256("fully-refunded-finalize");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);
        vm.prank(merchantOwner);
        checkout.refund(orderKey, intent.amount);
        vm.warp(intent.refundDeadline + 1);
        checkout.finalizeOrder(orderKey);
        assertTrue(checkout.getOrder(orderKey).finalized);
        assertEq(checkout.merchantCredit(merchantId), 0);
        assertEq(checkout.platformCredit(), 0);
        assertEq(checkout.totalLiability(), 0);
    }

    function testNonRefundableOrderCanFinalizeImmediately() external {
        OpenTabCheckout.ProductInput memory input = _productInput(merchantId);
        input.refundWindow = 0;
        vm.prank(merchantOwner);
        uint256 noRefundProduct = checkout.createProduct(input);
        vm.prank(merchantOwner);
        checkout.setProductActive(noRefundProduct, true);

        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("no-refund"), payer, recipient, 1);
        intent.productId = noRefundProduct;
        intent.refundDeadline = 0;
        _pay(intent);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.OrderNotRefundable.selector, intent.orderKey));
        vm.prank(merchantOwner);
        checkout.refund(intent.orderKey, 1);
        checkout.finalizeOrder(intent.orderKey);
        assertTrue(checkout.getOrder(intent.orderKey).finalized);
    }

    function testPauseBlocksPaymentRefundFinalizeAndWithdraw() external {
        bytes32 orderKey = keccak256("pause-money");
        OpenTabCheckout.OrderIntent memory intent = _intent(orderKey, payer, recipient, 1);
        _pay(intent);
        vm.warp(intent.refundDeadline + 1);
        vm.prank(pauser);
        checkout.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        checkout.finalizeOrder(orderKey);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(merchantOwner);
        checkout.refund(orderKey, 1);
    }

    function testUnsupportedOutboundTokenBehaviorRevertsRefundAndAccountingAtomically() external {
        MockToggleFeeUSDC token = new MockToggleFeeUSDC();
        OpenTabPass1155 freshPass = new OpenTabPass1155(admin, 1 days, address(this));
        OpenTabCheckout freshCheckout = new OpenTabCheckout(
            token, freshPass, admin, 1 days, pauser, feeManager, merchantManager, orderSigner, feeRecipient, FEE_BPS
        );
        freshPass.bindCheckout(address(freshCheckout));

        vm.prank(merchantOwner);
        uint256 freshMerchant = freshCheckout.createMerchant(merchantPayout, keccak256("merchant"));
        vm.prank(merchantOwner);
        uint256 freshProduct = freshCheckout.createProduct(_productInput(freshMerchant));
        vm.prank(merchantOwner);
        freshCheckout.setProductActive(freshProduct, true);
        token.mint(payer, UNIT_PRICE);
        vm.prank(payer);
        token.approve(address(freshCheckout), type(uint256).max);

        OpenTabCheckout.OrderIntent memory intent = OpenTabCheckout.OrderIntent({
            orderKey: keccak256("toggle-fee-refund"),
            payer: payer,
            recipient: recipient,
            merchantId: freshMerchant,
            productId: freshProduct,
            productVersion: 1,
            token: address(token),
            amount: UNIT_PRICE,
            platformFeeBps: FEE_BPS,
            platformFee: Math.mulDiv(UNIT_PRICE, FEE_BPS, 10_000),
            quantity: 1,
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 15 minutes),
            refundDeadline: uint64(block.timestamp + 15 minutes + REFUND_WINDOW),
            metadataHash: keccak256("product-v1")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_SIGNER_KEY, freshCheckout.hashOrderIntent(intent));
        vm.prank(payer);
        freshCheckout.pay(intent, abi.encodePacked(r, s, v));

        token.setFeeEnabled(true);
        uint256 received = UNIT_PRICE - (UNIT_PRICE / 100);
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.UnsupportedTokenBehavior.selector, UNIT_PRICE, received));
        vm.prank(merchantOwner);
        freshCheckout.refund(intent.orderKey, UNIT_PRICE);

        assertEq(freshCheckout.getOrder(intent.orderKey).refundedAmount, 0);
        assertEq(freshCheckout.totalLiability(), UNIT_PRICE);
        assertEq(token.balanceOf(address(freshCheckout)), UNIT_PRICE);
        assertEq(freshPass.balanceOf(recipient, freshProduct), 1);
    }
}
