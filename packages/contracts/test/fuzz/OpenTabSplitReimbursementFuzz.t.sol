// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {OpenTabSplitReimbursement} from "../../src/OpenTabSplitReimbursement.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabSplitReimbursementFuzzTest is BaseOpenTabTest {
    function testFuzz_ReimbursementIsExactAndPaymentKeyIsSingleUse(uint256 rawAmount, bytes32 salt) public {
        uint256 amount = bound(rawAmount, 1, 100_000_000_000);
        address participant = makeAddr("fuzz-participant");
        bytes32 paymentKey = keccak256(abi.encode("fuzz-split", salt, amount));
        OpenTabSplitReimbursement.SplitIntent memory intent = _splitIntent(paymentKey, participant, payer, amount);
        bytes memory signature = _signSplit(intent);
        usdc.mint(participant, amount);
        vm.prank(participant);
        usdc.approve(address(split), amount);

        uint256 beneficiaryBefore = usdc.balanceOf(payer);
        vm.prank(participant);
        split.reimburse(intent, signature);

        assertEq(usdc.balanceOf(payer), beneficiaryBefore + amount);
        assertEq(usdc.balanceOf(participant), 0);
        assertTrue(split.paymentKeyUsed(paymentKey));

        vm.expectRevert(abi.encodeWithSelector(OpenTabSplitReimbursement.PaymentKeyConsumed.selector, paymentKey));
        vm.prank(participant);
        split.reimburse(intent, signature);
    }

    function testFuzz_SignedAmountCannotBeMutated(uint256 rawAmount, uint256 rawMutation, bytes32 salt) public {
        uint256 amount = bound(rawAmount, 1, 100_000_000_000);
        uint256 mutatedAmount = bound(rawMutation, 1, 100_000_000_000);
        if (mutatedAmount == amount) mutatedAmount = amount == 100_000_000_000 ? amount - 1 : amount + 1;
        address participant = makeAddr("mutation-participant");
        OpenTabSplitReimbursement.SplitIntent memory intent =
            _splitIntent(keccak256(abi.encode("mutation", salt)), participant, payer, amount);
        bytes memory signature = _signSplit(intent);
        intent.amount = mutatedAmount;
        usdc.mint(participant, mutatedAmount);
        vm.prank(participant);
        usdc.approve(address(split), mutatedAmount);

        vm.expectRevert(OpenTabSplitReimbursement.InvalidSplitSignature.selector);
        vm.prank(participant);
        split.reimburse(intent, signature);
        assertFalse(split.paymentKeyUsed(intent.paymentKey));
    }
}
