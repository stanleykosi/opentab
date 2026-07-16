// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {IOpenTabPass} from "../../src/interfaces/IOpenTabPass.sol";
import {BaseOpenTabTest} from "../BaseOpenTabTest.sol";

contract OpenTabCheckoutNegativeTest is BaseOpenTabTest {
    function testConstructorRejectsZeroRolesAndNonContracts() external {
        vm.expectRevert(OpenTabCheckout.ZeroAddress.selector);
        new OpenTabCheckout(
            usdc, pass, admin, 1 days, address(0), feeManager, merchantManager, orderSigner, feeRecipient, FEE_BPS
        );

        address noCode = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidContract.selector, noCode));
        new OpenTabCheckout(
            IERC20Metadata(noCode),
            pass,
            admin,
            1 days,
            pauser,
            feeManager,
            merchantManager,
            orderSigner,
            feeRecipient,
            FEE_BPS
        );

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidContract.selector, noCode));
        new OpenTabCheckout(
            usdc,
            IOpenTabPass(noCode),
            admin,
            1 days,
            pauser,
            feeManager,
            merchantManager,
            orderSigner,
            feeRecipient,
            FEE_BPS
        );
    }

    function testUnknownMerchantProductOrderAndInsufficientPlatformCreditRevert() external {
        uint256 unknownMerchant = 999;
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.MerchantNotFound.selector, unknownMerchant));
        vm.prank(merchantOwner);
        checkout.updateMerchantPayout(unknownMerchant, merchantPayout);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.ProductNotFound.selector, 999));
        checkout.quote(999, 1);

        bytes32 unknownOrder = keccak256("unknown-order");
        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.OrderNotFound.selector, unknownOrder));
        checkout.finalizeOrder(unknownOrder);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.InsufficientPlatformBalance.selector, 1, 0));
        vm.prank(feeRecipient);
        checkout.withdrawPlatform(1);
    }

    function testProductInputAndPayoutValidation() external {
        OpenTabCheckout.ProductInput memory input = _productInput(merchantId);
        input.unitPrice = 0;
        vm.expectRevert(OpenTabCheckout.InvalidAmount.selector);
        vm.prank(merchantOwner);
        checkout.createProduct(input);

        input = _productInput(merchantId);
        input.endsAt = input.startsAt;
        vm.expectRevert(OpenTabCheckout.InvalidWindow.selector);
        vm.prank(merchantOwner);
        checkout.createProduct(input);

        vm.expectRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidPayout.selector, address(checkout)));
        vm.prank(merchantOwner);
        checkout.updateMerchantPayout(merchantId, address(checkout));
    }

    function testInactiveMerchantAndProductRevertPayments() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("inactive-product"), payer, recipient, 1);
        vm.prank(merchantOwner);
        checkout.setProductActive(productId, false);
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.ProductInactive.selector, productId), payer, intent);

        vm.prank(merchantOwner);
        checkout.setProductActive(productId, true);
        vm.prank(merchantOwner);
        checkout.setMerchantActive(merchantId, false);
        intent.orderKey = keccak256("inactive-merchant");
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.MerchantInactive.selector, merchantId), payer, intent);
    }

    function testProductMerchantAndUnknownProductBindingsRevert() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("merchant-mismatch"), payer, recipient, 1);
        intent.merchantId = merchantId + 1;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.ProductMerchantMismatch.selector, merchantId, merchantId + 1),
            payer,
            intent
        );

        intent = _intent(keccak256("unknown-product"), payer, recipient, 1);
        intent.productId = 999;
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.ProductNotFound.selector, 999), payer, intent);
    }

    function testSaleStartAndEndWindowsAreAuthoritative() external {
        OpenTabCheckout.ProductInput memory futureInput = _productInput(merchantId);
        futureInput.startsAt = uint64(block.timestamp + 1 days);
        futureInput.endsAt = uint64(block.timestamp + 2 days);
        vm.prank(merchantOwner);
        uint256 futureProduct = checkout.createProduct(futureInput);
        vm.prank(merchantOwner);
        checkout.setProductActive(futureProduct, true);

        OpenTabCheckout.OrderIntent memory intent = _intent(keccak256("not-started"), payer, recipient, 1);
        intent.productId = futureProduct;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.SaleNotStarted.selector, futureInput.startsAt), payer, intent
        );

        OpenTabCheckout.ProductInput memory endingInput = _productInput(merchantId);
        endingInput.endsAt = uint64(block.timestamp + 1);
        vm.prank(merchantOwner);
        uint256 endingProduct = checkout.createProduct(endingInput);
        vm.prank(merchantOwner);
        checkout.setProductActive(endingProduct, true);
        vm.warp(block.timestamp + 2);

        intent = _intent(keccak256("ended"), payer, recipient, 1);
        intent.productId = endingProduct;
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.SaleEnded.selector, endingInput.endsAt), payer, intent);
    }

    function testIntentKeyRecipientAndValidityBounds() external {
        OpenTabCheckout.OrderIntent memory intent = _intent(bytes32(0), payer, recipient, 1);
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.OrderKeyZero.selector), payer, intent);

        intent = _intent(keccak256("zero-recipient"), payer, address(0), 1);
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.ZeroAddress.selector), payer, intent);

        intent = _intent(keccak256("invalid-window"), payer, recipient, 1);
        intent.validUntil = intent.validAfter - 1;
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidWindow.selector), payer, intent);

        intent = _intent(keccak256("future-intent"), payer, recipient, 1);
        intent.validAfter = uint64(block.timestamp + 1);
        intent.validUntil = intent.validAfter + 15 minutes;
        intent.refundDeadline = intent.validUntil + REFUND_WINDOW;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.IntentNotYetValid.selector, intent.validAfter), payer, intent
        );

        intent = _intent(keccak256("long-intent"), payer, recipient, 1);
        intent.validUntil = intent.validAfter + checkout.MAX_INTENT_VALIDITY() + 1;
        intent.refundDeadline = intent.validUntil + REFUND_WINDOW;
        _expectPayRevert(
            abi.encodeWithSelector(OpenTabCheckout.IntentValidityTooLong.selector, checkout.MAX_INTENT_VALIDITY() + 1),
            payer,
            intent
        );
    }

    function testGrossAbovePackedOrderLimitRevertsBeforeStateChange() external {
        OpenTabCheckout.ProductInput memory input = _productInput(merchantId);
        input.unitPrice = type(uint128).max;
        input.maxPerWallet = 0;
        vm.prank(merchantOwner);
        uint256 expensiveProduct = checkout.createProduct(input);
        vm.prank(merchantOwner);
        checkout.setProductActive(expensiveProduct, true);

        uint256 gross = uint256(type(uint128).max) * 2;
        OpenTabCheckout.OrderIntent memory intent = OpenTabCheckout.OrderIntent({
            orderKey: keccak256("too-large"),
            payer: payer,
            recipient: recipient,
            merchantId: merchantId,
            productId: expensiveProduct,
            productVersion: 1,
            token: address(usdc),
            amount: gross,
            platformFeeBps: FEE_BPS,
            platformFee: Math.mulDiv(gross, FEE_BPS, 10_000),
            quantity: 2,
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 15 minutes),
            refundDeadline: uint64(block.timestamp + 15 minutes + REFUND_WINDOW),
            metadataHash: input.metadataHash
        });
        _expectPayRevert(abi.encodeWithSelector(OpenTabCheckout.InvalidAmount.selector), payer, intent);
        assertFalse(checkout.orderExists(intent.orderKey));
        assertEq(checkout.getProduct(expensiveProduct).sold, 0);
        assertEq(checkout.totalLiability(), 0);
    }
}
