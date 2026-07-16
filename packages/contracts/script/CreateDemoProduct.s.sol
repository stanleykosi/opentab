// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";

contract CreateDemoProduct is Script {
    function run() external returns (uint256 productId) {
        address merchant = vm.envAddress("MERCHANT_ADDRESS");
        require(merchant != address(0), "MERCHANT_ADDRESS is zero");
        uint256 rawUnitPrice = vm.envUint("PRODUCT_UNIT_PRICE_BASE_UNITS");
        uint256 rawStartsAt = vm.envUint("PRODUCT_STARTS_AT");
        uint256 rawEndsAt = vm.envUint("PRODUCT_ENDS_AT");
        uint256 rawMaxSupply = vm.envUint("PRODUCT_MAX_SUPPLY");
        uint256 rawMaxPerWallet = vm.envUint("PRODUCT_MAX_PER_WALLET");
        uint256 rawLoyalty = vm.envUint("PRODUCT_LOYALTY_POINTS");
        uint256 rawRefundWindow = vm.envUint("PRODUCT_REFUND_WINDOW_SECONDS");
        require(rawUnitPrice <= type(uint128).max, "unit price overflow");
        require(rawStartsAt <= type(uint64).max && rawEndsAt <= type(uint64).max, "sale time overflow");
        require(rawMaxSupply <= type(uint64).max && rawMaxPerWallet <= type(uint64).max, "quantity overflow");
        require(rawLoyalty <= type(uint32).max && rawRefundWindow <= type(uint32).max, "policy overflow");

        OpenTabCheckout checkout = OpenTabCheckout(vm.envAddress("CHECKOUT_ADDRESS"));
        OpenTabCheckout.ProductInput memory input = OpenTabCheckout.ProductInput({
            merchantId: vm.envUint("MERCHANT_ID"),
            unitPrice: uint128(rawUnitPrice),
            startsAt: uint64(rawStartsAt),
            endsAt: uint64(rawEndsAt),
            maxSupply: uint64(rawMaxSupply),
            maxPerWallet: uint64(rawMaxPerWallet),
            loyaltyPoints: uint32(rawLoyalty),
            refundWindow: uint32(rawRefundWindow),
            metadataHash: vm.envBytes32("PRODUCT_METADATA_HASH"),
            passUri: vm.envString("PRODUCT_PASS_URI")
        });

        vm.startBroadcast(merchant);
        productId = checkout.createProduct(input);
        checkout.setProductActive(productId, true);
        vm.stopBroadcast();
    }
}
