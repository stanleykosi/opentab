// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract OpenTabCheckoutHandler is Test {
    uint256 internal constant ORDER_SIGNER_KEY = 0xA11CE;
    uint16 internal constant FEE_BPS = 250;
    uint32 internal constant REFUND_WINDOW = 1 days;
    uint128 internal constant UNIT_PRICE = 12_500_000;

    OpenTabCheckout public immutable checkout;
    MockUSDC public immutable usdc;

    address public immutable pauser;
    address public immutable feeRecipient;
    uint256[] private _merchantIds;
    uint256[] private _productIds;
    address[] private _merchantOwners;
    address[] private _payers;
    bytes32[] private _orderKeys;
    uint256 private _orderNonce;

    constructor(
        OpenTabCheckout checkout_,
        MockUSDC usdc_,
        address pauser_,
        address feeRecipient_,
        uint256[] memory merchantIds_,
        uint256[] memory productIds_,
        address[] memory merchantOwners_,
        address[] memory payers_
    ) {
        checkout = checkout_;
        usdc = usdc_;
        pauser = pauser_;
        feeRecipient = feeRecipient_;
        _merchantIds = merchantIds_;
        _productIds = productIds_;
        _merchantOwners = merchantOwners_;
        _payers = payers_;
    }

    function pay(uint256 productSeed, uint256 payerSeed, uint64 quantitySeed) external {
        if (checkout.paused()) return;
        uint256 index = bound(productSeed, 0, _productIds.length - 1);
        address payer = _payers[bound(payerSeed, 0, _payers.length - 1)];
        uint64 quantity = uint64(bound(quantitySeed, 1, 10));
        uint256 productId = _productIds[index];
        OpenTabCheckout.Product memory product = checkout.getProduct(productId);
        bytes32 orderKey = keccak256(abi.encode("invariant-order", ++_orderNonce));
        uint64 validAfter = uint64(block.timestamp);
        uint64 validUntil = validAfter + 15 minutes;
        uint256 amount = uint256(product.unitPrice) * quantity;
        OpenTabCheckout.OrderIntent memory intent = OpenTabCheckout.OrderIntent({
            orderKey: orderKey,
            payer: payer,
            recipient: payer,
            merchantId: product.merchantId,
            productId: productId,
            productVersion: product.version,
            token: address(usdc),
            amount: amount,
            platformFeeBps: FEE_BPS,
            platformFee: Math.mulDiv(amount, FEE_BPS, 10_000),
            quantity: quantity,
            validAfter: validAfter,
            validUntil: validUntil,
            refundDeadline: validUntil + REFUND_WINDOW,
            metadataHash: product.metadataHash
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_SIGNER_KEY, checkout.hashOrderIntent(intent));
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(payer);
        try checkout.pay(intent, signature) {
            _orderKeys.push(orderKey);
        } catch {}
    }

    function refund(uint256 orderSeed, uint256 amountSeed) external {
        if (checkout.paused() || _orderKeys.length == 0) return;
        bytes32 orderKey = _orderKeys[bound(orderSeed, 0, _orderKeys.length - 1)];
        OpenTabCheckout.Order memory order = checkout.getOrder(orderKey);
        if (
            order.finalized || order.refundDeadline == 0 || block.timestamp > order.refundDeadline
                || order.refundedAmount == order.grossAmount
        ) return;
        uint256 amount = bound(amountSeed, 1, uint256(order.grossAmount) - order.refundedAmount);
        address owner = _ownerForMerchant(order.merchantId);
        vm.prank(owner);
        try checkout.refund(orderKey, amount) {} catch {}
    }

    function finalize(uint256 orderSeed) external {
        if (checkout.paused() || _orderKeys.length == 0) return;
        bytes32 orderKey = _orderKeys[bound(orderSeed, 0, _orderKeys.length - 1)];
        OpenTabCheckout.Order memory order = checkout.getOrder(orderKey);
        if (order.finalized || (order.refundDeadline != 0 && block.timestamp <= order.refundDeadline)) return;
        try checkout.finalizeOrder(orderKey) {} catch {}
    }

    function withdrawMerchant(uint256 merchantSeed, uint256 amountSeed) external {
        if (checkout.paused()) return;
        uint256 index = bound(merchantSeed, 0, _merchantIds.length - 1);
        uint256 merchantId = _merchantIds[index];
        uint256 credit = checkout.merchantCredit(merchantId);
        if (credit == 0) return;
        uint256 amount = bound(amountSeed, 1, credit);
        address payout = checkout.getMerchant(merchantId).payout;
        vm.prank(_merchantOwners[index]);
        try checkout.withdrawMerchant(merchantId, amount, payout) {} catch {}
    }

    function withdrawPlatform(uint256 amountSeed) external {
        if (checkout.paused()) return;
        uint256 credit = checkout.platformCredit();
        if (credit == 0) return;
        uint256 amount = bound(amountSeed, 1, credit);
        vm.prank(feeRecipient);
        try checkout.withdrawPlatform(amount) {} catch {}
    }

    function advanceTime(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 2 days));
    }

    function togglePause(bool shouldPause) external {
        bool isPaused = checkout.paused();
        if (shouldPause == isPaused) return;
        vm.prank(pauser);
        if (shouldPause) checkout.pause();
        else checkout.unpause();
    }

    function merchantIds() external view returns (uint256[] memory) {
        return _merchantIds;
    }

    function productIds() external view returns (uint256[] memory) {
        return _productIds;
    }

    function orderKeys() external view returns (bytes32[] memory) {
        return _orderKeys;
    }

    function _ownerForMerchant(uint256 merchantId) internal view returns (address) {
        for (uint256 i; i < _merchantIds.length; ++i) {
            if (_merchantIds[i] == merchantId) return _merchantOwners[i];
        }
        revert("unknown merchant");
    }
}

contract OpenTabCheckoutInvariantTest is StdInvariant, Test {
    uint256 internal constant ORDER_SIGNER_KEY = 0xA11CE;
    uint16 internal constant FEE_BPS = 250;

    MockUSDC internal usdc;
    OpenTabPass1155 internal pass;
    OpenTabCheckout internal checkout;
    OpenTabCheckoutHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        address admin = makeAddr("invariant-admin");
        address pauser = makeAddr("invariant-pauser");
        address feeManager = makeAddr("invariant-fee-manager");
        address merchantManager = makeAddr("invariant-merchant-manager");
        address feeRecipient = makeAddr("invariant-fee-recipient");
        usdc = new MockUSDC();
        pass = new OpenTabPass1155(admin, 1 days, address(this));
        checkout = new OpenTabCheckout(
            usdc,
            pass,
            admin,
            1 days,
            pauser,
            feeManager,
            merchantManager,
            vm.addr(ORDER_SIGNER_KEY),
            feeRecipient,
            FEE_BPS
        );
        pass.bindCheckout(address(checkout));

        uint256[] memory merchantIds = new uint256[](2);
        uint256[] memory productIds = new uint256[](2);
        address[] memory owners = new address[](2);
        address[] memory payers = new address[](2);
        for (uint256 i; i < 2; ++i) {
            owners[i] = makeAddr(string.concat("invariant-owner-", vm.toString(i)));
            address payout = makeAddr(string.concat("invariant-payout-", vm.toString(i)));
            vm.prank(owners[i]);
            merchantIds[i] = checkout.createMerchant(payout, keccak256(abi.encode("merchant", i)));
            vm.prank(owners[i]);
            productIds[i] = checkout.createProduct(
                OpenTabCheckout.ProductInput({
                    merchantId: merchantIds[i],
                    unitPrice: 12_500_000,
                    startsAt: uint64(block.timestamp - 1),
                    endsAt: 0,
                    maxSupply: 0,
                    maxPerWallet: 0,
                    loyaltyPoints: 25,
                    refundWindow: 1 days,
                    metadataHash: keccak256(abi.encode("product", i)),
                    passUri: string.concat("ipfs://invariant/", vm.toString(i))
                })
            );
            vm.prank(owners[i]);
            checkout.setProductActive(productIds[i], true);
            payers[i] = makeAddr(string.concat("invariant-payer-", vm.toString(i)));
            usdc.mint(payers[i], 1e30);
            vm.prank(payers[i]);
            usdc.approve(address(checkout), type(uint256).max);
        }

        handler =
            new OpenTabCheckoutHandler(checkout, usdc, pauser, feeRecipient, merchantIds, productIds, owners, payers);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.pay.selector;
        selectors[1] = handler.refund.selector;
        selectors[2] = handler.finalize.selector;
        selectors[3] = handler.withdrawMerchant.selector;
        selectors[4] = handler.withdrawPlatform.selector;
        selectors[5] = handler.advanceTime.selector;
        selectors[6] = handler.togglePause.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_TokenBalanceExactlyCoversRecordedLiability() public view {
        assertEq(usdc.balanceOf(address(checkout)), checkout.totalLiability());
    }

    function invariant_AccountingBucketsReconcileAcrossMerchants() public view {
        uint256[] memory merchantIds = handler.merchantIds();
        uint256 locked;
        uint256 credit;
        for (uint256 i; i < merchantIds.length; ++i) {
            locked += checkout.merchantLocked(merchantIds[i]);
            credit += checkout.merchantCredit(merchantIds[i]);
        }
        assertEq(locked + checkout.platformLocked(), checkout.totalLockedLiability());
        assertEq(credit, checkout.totalMerchantCredit());
    }

    function invariant_OrderRoundingAndMerchantIsolationConserveValue() public view {
        uint256[] memory merchantIds = handler.merchantIds();
        bytes32[] memory keys = handler.orderKeys();
        uint256[] memory netPaid = new uint256[](merchantIds.length);
        uint256[] memory merchantRefunded = new uint256[](merchantIds.length);
        uint256 totalFees;
        uint256 totalPlatformRefunded;

        for (uint256 i; i < keys.length; ++i) {
            OpenTabCheckout.Order memory order = checkout.getOrder(keys[i]);
            assertLe(order.refundedAmount, order.grossAmount);
            assertEq(uint256(order.merchantRefunded) + order.platformRefunded, order.refundedAmount);
            assertEq(order.platformRefunded, Math.mulDiv(order.platformFee, order.refundedAmount, order.grossAmount));
            assertEq(order.loyaltyRefunded, Math.mulDiv(order.loyaltyAwarded, order.refundedAmount, order.grossAmount));
            uint256 merchantIndex = _merchantIndex(merchantIds, order.merchantId);
            netPaid[merchantIndex] += uint256(order.grossAmount) - order.platformFee;
            merchantRefunded[merchantIndex] += order.merchantRefunded;
            totalFees += order.platformFee;
            totalPlatformRefunded += order.platformRefunded;
        }

        for (uint256 i; i < merchantIds.length; ++i) {
            uint256 merchantId = merchantIds[i];
            assertEq(
                netPaid[i],
                checkout.merchantLocked(merchantId) + checkout.merchantCredit(merchantId)
                    + checkout.merchantWithdrawn(merchantId) + merchantRefunded[i]
            );
        }
        assertEq(
            totalFees,
            checkout.platformLocked() + checkout.platformCredit() + checkout.platformWithdrawn() + totalPlatformRefunded
        );
    }

    function invariant_PassSupplyTracksPaidAndFullyRefundedOrders() public view {
        uint256[] memory productIds = handler.productIds();
        bytes32[] memory keys = handler.orderKeys();
        uint256[] memory expectedSupply = new uint256[](productIds.length);
        uint256[] memory expectedSold = new uint256[](productIds.length);
        for (uint256 i; i < keys.length; ++i) {
            OpenTabCheckout.Order memory order = checkout.getOrder(keys[i]);
            uint256 productIndex = _productIndex(productIds, order.productId);
            expectedSold[productIndex] += order.quantity;
            if (order.refundedAmount != order.grossAmount) expectedSupply[productIndex] += order.quantity;
        }
        for (uint256 i; i < productIds.length; ++i) {
            assertEq(pass.totalSupply(productIds[i]), expectedSupply[i]);
            assertEq(checkout.getProduct(productIds[i]).sold, expectedSold[i]);
        }
    }

    function _merchantIndex(uint256[] memory merchantIds, uint256 merchantId) internal pure returns (uint256) {
        for (uint256 i; i < merchantIds.length; ++i) {
            if (merchantIds[i] == merchantId) return i;
        }
        revert("unknown merchant");
    }

    function _productIndex(uint256[] memory productIds, uint256 productId) internal pure returns (uint256) {
        for (uint256 i; i < productIds.length; ++i) {
            if (productIds[i] == productId) return i;
        }
        revert("unknown product");
    }
}
