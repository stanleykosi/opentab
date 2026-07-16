// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";

/// @notice Grants or revokes the bounded refund-operator role from the delayed admin account.
contract ConfigureRefundOperator is Script {
    function run() external {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        require(admin != address(0), "ADMIN_ADDRESS is zero");
        OpenTabCheckout checkout = OpenTabCheckout(vm.envAddress("CHECKOUT_ADDRESS"));
        address operator = vm.envAddress("REFUND_OPERATOR_ADDRESS");
        require(operator != address(0), "zero refund operator");
        bool enabled = vm.envBool("REFUND_OPERATOR_ENABLED");

        vm.startBroadcast(admin);
        if (enabled) checkout.grantRole(checkout.REFUND_OPERATOR_ROLE(), operator);
        else checkout.revokeRole(checkout.REFUND_OPERATOR_ROLE(), operator);
        vm.stopBroadcast();
    }
}
