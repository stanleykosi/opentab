// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";

contract CreateDemoMerchant is Script {
    function run() external returns (uint256 merchantId) {
        address merchant = vm.envAddress("MERCHANT_ADDRESS");
        require(merchant != address(0), "MERCHANT_ADDRESS is zero");
        OpenTabCheckout checkout = OpenTabCheckout(vm.envAddress("CHECKOUT_ADDRESS"));
        address payout = vm.envAddress("MERCHANT_PAYOUT_ADDRESS");
        bytes32 metadataHash = vm.envBytes32("MERCHANT_METADATA_HASH");

        vm.startBroadcast(merchant);
        merchantId = checkout.createMerchant(payout, metadataHash);
        vm.stopBroadcast();
    }
}
