// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabCheckoutFuzzTest is BaseOpenTabTest {
    function testFuzz_PaymentAccountingUsesExactSignedFee(uint64 rawQuantity, uint16 rawFeeBps) public {
        uint64 quantity = uint64(bound(rawQuantity, 1, 10));
        uint16 feeBps = uint16(bound(rawFeeBps, 0, checkout.MAX_PLATFORM_FEE_BPS()));
        OpenTabCheckout.OrderIntent memory intent =
            _intent(keccak256(abi.encode("fuzz-pay", quantity, feeBps)), payer, recipient, quantity);
        intent.platformFeeBps = feeBps;
        intent.platformFee = Math.mulDiv(intent.amount, feeBps, 10_000);

        uint256 payerBefore = usdc.balanceOf(payer);
        _pay(intent);

        OpenTabCheckout.Order memory order = checkout.getOrder(intent.orderKey);
        assertEq(usdc.balanceOf(payer), payerBefore - intent.amount);
        assertEq(usdc.balanceOf(address(checkout)), intent.amount);
        assertEq(checkout.totalLiability(), intent.amount);
        assertEq(checkout.merchantLocked(merchantId), intent.amount - intent.platformFee);
        assertEq(checkout.platformLocked(), intent.platformFee);
        assertEq(order.platformFeeBps, feeBps);
        assertEq(order.platformFee, intent.platformFee);
        assertEq(pass.balanceOf(recipient, productId), quantity);
    }

    function testFuzz_PartialRefundsUseCumulativeFeeAndLoyaltyRounding(
        uint64 rawQuantity,
        uint256 rawFirstRefund,
        uint256 rawSecondRefund
    ) public {
        uint64 quantity = uint64(bound(rawQuantity, 1, 10));
        OpenTabCheckout.OrderIntent memory intent = _intent(
            keccak256(abi.encode("fuzz-refund", quantity, rawFirstRefund, rawSecondRefund)), payer, recipient, quantity
        );
        _pay(intent);

        uint256 firstRefund = bound(rawFirstRefund, 1, intent.amount);
        vm.prank(merchantOwner);
        checkout.refund(intent.orderKey, firstRefund);
        _assertCumulativeRefund(intent, firstRefund);

        uint256 remaining = intent.amount - firstRefund;
        if (remaining != 0) {
            uint256 secondRefund = bound(rawSecondRefund, 1, remaining);
            vm.prank(merchantOwner);
            checkout.refund(intent.orderKey, secondRefund);
            _assertCumulativeRefund(intent, firstRefund + secondRefund);
        }
    }

    function _assertCumulativeRefund(OpenTabCheckout.OrderIntent memory intent, uint256 cumulativeRefund)
        internal
        view
    {
        OpenTabCheckout.Order memory order = checkout.getOrder(intent.orderKey);
        uint256 expectedFeeRefund = Math.mulDiv(intent.platformFee, cumulativeRefund, intent.amount);
        uint256 awarded = uint256(25) * intent.quantity;
        uint256 expectedLoyaltyRefund = Math.mulDiv(awarded, cumulativeRefund, intent.amount);

        assertEq(order.refundedAmount, cumulativeRefund);
        assertEq(order.platformRefunded, expectedFeeRefund);
        assertEq(order.merchantRefunded, cumulativeRefund - expectedFeeRefund);
        assertEq(order.loyaltyRefunded, expectedLoyaltyRefund);
        assertEq(checkout.loyaltyPoints(merchantId, recipient), awarded - expectedLoyaltyRefund);
        assertEq(checkout.totalLiability(), intent.amount - cumulativeRefund);
        assertEq(usdc.balanceOf(address(checkout)), intent.amount - cumulativeRefund);
        assertEq(pass.balanceOf(recipient, productId), cumulativeRefund == intent.amount ? 0 : intent.quantity);
    }
}
