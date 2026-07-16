// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";
import {MockWrongDecimalsUSDC} from "../mocks/MockUSDC.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabCheckoutLifecycleTest is BaseOpenTabTest {
    function testMerchantLifecycleAndStoredPayout() external {
        OpenTabCheckout.Merchant memory merchant = checkout.getMerchant(merchantId);
        assertEq(merchant.owner, merchantOwner);
        assertEq(merchant.payout, merchantPayout);
        assertTrue(merchant.active);
        assertFalse(merchant.suspended);

        address replacement = makeAddr("replacementPayout");
        vm.prank(merchantOwner);
        checkout.updateMerchantPayout(merchantId, replacement);
        assertEq(checkout.getMerchant(merchantId).payout, replacement);

        vm.prank(merchantOwner);
        checkout.setMerchantActive(merchantId, false);
        assertFalse(checkout.getMerchant(merchantId).active);

        vm.prank(merchantManager);
        checkout.setMerchantSuspended(merchantId, true);
        assertTrue(checkout.getMerchant(merchantId).suspended);
    }

    function testMerchantAuthorizationAndValidation() external {
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.UnauthorizedMerchant.selector, merchantId, payer));
        vm.prank(payer);
        checkout.updateMerchantPayout(merchantId, payer);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidPayout.selector, address(0)));
        vm.prank(merchantOwner);
        checkout.updateMerchantPayout(merchantId, address(0));

        vm.expectRevert(OpenTabCheckout.InvalidMetadataHash.selector);
        vm.prank(merchantOwner);
        checkout.updateMerchantMetadata(merchantId, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, payer, checkout.MERCHANT_MANAGER_ROLE()
            )
        );
        vm.prank(payer);
        checkout.setMerchantSuspended(merchantId, true);
    }

    function testProductStartsInactiveThenCanUpdateAndActivate() external {
        vm.prank(merchantOwner);
        uint256 fresh = checkout.createProduct(_productInput(merchantId));
        OpenTabCheckout.Product memory product = checkout.getProduct(fresh);
        assertFalse(product.active);
        assertEq(product.version, 1);

        OpenTabCheckout.ProductUpdate memory update = OpenTabCheckout.ProductUpdate({
            unitPrice: 42_000_000,
            startsAt: uint64(block.timestamp),
            endsAt: uint64(block.timestamp + 10 days),
            maxSupply: 50,
            maxPerWallet: 4,
            loyaltyPoints: 100,
            refundWindow: 2 days,
            metadataHash: keccak256("product-v2"),
            passUri: "ipfs://opentab/product-v2"
        });
        vm.prank(merchantOwner);
        checkout.updateProduct(fresh, update);
        product = checkout.getProduct(fresh);
        assertEq(product.version, 2);
        assertEq(product.unitPrice, 42_000_000);
        assertEq(pass.uri(fresh), "ipfs://opentab/product-v2");

        vm.prank(merchantOwner);
        checkout.setProductActive(fresh, true);
        assertTrue(checkout.getProduct(fresh).active);
    }

    function testCannotUpdateSoldProduct() external {
        _pay(_intent(keccak256("sold"), payer, recipient, 1));
        OpenTabCheckout.ProductUpdate memory update = OpenTabCheckout.ProductUpdate({
            unitPrice: uint128(UNIT_PRICE),
            startsAt: uint64(block.timestamp),
            endsAt: uint64(block.timestamp + 10 days),
            maxSupply: 50,
            maxPerWallet: 4,
            loyaltyPoints: 100,
            refundWindow: 2 days,
            metadataHash: keccak256("new"),
            passUri: "ipfs://new"
        });
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.ProductHasSales.selector, productId));
        vm.prank(merchantOwner);
        checkout.updateProduct(productId, update);
    }

    function testProductUpdateInvalidatesPreviouslySignedIntent() external {
        vm.prank(merchantOwner);
        uint256 fresh = checkout.createProduct(_productInput(merchantId));
        vm.prank(merchantOwner);
        checkout.setProductActive(fresh, true);

        OpenTabCheckout.OrderIntent memory stale = _intent(keccak256("stale-product"), payer, recipient, 1);
        stale.productId = fresh;
        bytes memory signature = _signIntent(stale);

        OpenTabCheckout.ProductUpdate memory update = OpenTabCheckout.ProductUpdate({
            unitPrice: uint128(UNIT_PRICE),
            startsAt: uint64(block.timestamp - 1),
            endsAt: uint64(block.timestamp + 20 days),
            maxSupply: 1_000,
            maxPerWallet: 10,
            loyaltyPoints: 25,
            refundWindow: REFUND_WINDOW,
            metadataHash: keccak256("product-v1"),
            passUri: "ipfs://opentab/product-v1"
        });
        vm.prank(merchantOwner);
        checkout.updateProduct(fresh, update);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.ProductVersionMismatch.selector, uint64(2), uint64(1)));
        vm.prank(payer);
        checkout.pay(stale, signature);
    }

    function testSuspendedMerchantCannotActivateOrSell() external {
        vm.prank(merchantManager);
        checkout.setMerchantSuspended(merchantId, true);

        vm.prank(merchantOwner);
        checkout.setProductActive(productId, false);
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.MerchantSuspended.selector, merchantId));
        vm.prank(merchantOwner);
        checkout.setProductActive(productId, true);

        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("suspended"), payer, recipient, 1);
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.ProductInactive.selector, productId), payer, intent);
    }

    function testPauseBlocksSensitiveLifecycleActions() external {
        vm.prank(pauser);
        checkout.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(merchantOwner);
        checkout.createMerchant(merchantPayout, keccak256("another"));

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(merchantOwner);
        checkout.setProductActive(productId, false);

        vm.prank(pauser);
        checkout.unpause();
        vm.prank(merchantOwner);
        checkout.setProductActive(productId, false);
    }

    function testFeeManagementIsCappedAndRoleBound() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, payer, checkout.FEE_MANAGER_ROLE()
            )
        );
        vm.prank(payer);
        checkout.setPlatformFeeBps(100);

        uint16 tooHigh = checkout.MAX_PLATFORM_FEE_BPS() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                OpenTabCheckout.FeeTooHigh.selector, uint256(tooHigh), uint256(checkout.MAX_PLATFORM_FEE_BPS())
            )
        );
        vm.prank(feeManager);
        checkout.setPlatformFeeBps(tooHigh);

        vm.prank(feeManager);
        checkout.setPlatformFeeBps(100);
        assertEq(checkout.platformFeeBps(), 100);
    }

    function testConstructorRejectsWrongDecimals() external {
        MockWrongDecimalsUSDC wrong = new MockWrongDecimalsUSDC();
        OpenTabPass1155 freshPass = new OpenTabPass1155(admin, 1 days, address(this));
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidTokenDecimals.selector, uint8(18)));
        new OpenTabCheckout(
            wrong, freshPass, admin, 1 days, pauser, feeManager, merchantManager, orderSigner, feeRecipient, FEE_BPS
        );
    }
}
