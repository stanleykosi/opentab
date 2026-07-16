// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";
import {OpenTabSplitReimbursement} from "../src/OpenTabSplitReimbursement.sol";

contract PauseOpenTab is Script {
    function run() external {
        address pauser = vm.envAddress("PAUSER_ADDRESS");
        require(pauser != address(0), "PAUSER_ADDRESS is zero");
        OpenTabCheckout checkout = OpenTabCheckout(vm.envAddress("CHECKOUT_ADDRESS"));
        OpenTabSplitReimbursement split = OpenTabSplitReimbursement(vm.envAddress("SPLIT_REIMBURSEMENT_ADDRESS"));
        vm.startBroadcast(pauser);
        checkout.pause();
        split.pause();
        vm.stopBroadcast();
    }
}
