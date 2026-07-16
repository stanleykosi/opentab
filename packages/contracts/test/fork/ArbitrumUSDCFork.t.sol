// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";

contract ArbitrumUSDCForkTest is Test {
    uint256 internal constant ARBITRUM_ONE_CHAIN_ID = 42_161;
    address internal constant ARBITRUM_ONE_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    uint256 internal constant ORDER_SIGNER_KEY = 0xA11CE;
    uint16 internal constant FEE_BPS = 250;

    bool internal forkConfigured;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        uint256 forkBlock = vm.envOr("ARBITRUM_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpcUrl);
        else vm.createSelectFork(rpcUrl, forkBlock);
        forkConfigured = true;
    }

    function testFork_NativeUsdcAddressCodeAndDecimals() public {
        if (!forkConfigured) vm.skip(true);
        assertEq(block.chainid, ARBITRUM_ONE_CHAIN_ID);
        assertGt(ARBITRUM_ONE_USDC.code.length, 0);
        assertEq(IERC20Metadata(ARBITRUM_ONE_USDC).decimals(), 6);
    }

    function testFork_NativeUsdcExecutesExactCheckoutPayment() public {
        if (!forkConfigured) vm.skip(true);
        address admin = makeAddr("fork-admin");
        address pauser = makeAddr("fork-pauser");
        address feeManager = makeAddr("fork-fee-manager");
        address merchantManager = makeAddr("fork-merchant-manager");
        address feeRecipient = makeAddr("fork-fee-recipient");
        address merchant = makeAddr("fork-merchant");
        address payout = makeAddr("fork-payout");
        address payer = makeAddr("fork-payer");
        address signer = vm.addr(ORDER_SIGNER_KEY);

        OpenTabPass1155 pass = new OpenTabPass1155(admin, 1 days, address(this));
        OpenTabCheckout checkout = new OpenTabCheckout(
            IERC20Metadata(ARBITRUM_ONE_USDC),
            pass,
            admin,
            1 days,
            pauser,
            feeManager,
            merchantManager,
            signer,
            feeRecipient,
            FEE_BPS
        );
        pass.bindCheckout(address(checkout));

        vm.prank(merchant);
        uint256 merchantId = checkout.createMerchant(payout, keccak256("fork-merchant"));
        vm.prank(merchant);
        uint256 productId = checkout.createProduct(
            OpenTabCheckout.ProductInput({
                merchantId: merchantId,
                unitPrice: 1_000_000,
                startsAt: uint64(block.timestamp - 1),
                endsAt: 0,
                maxSupply: 10,
                maxPerWallet: 2,
                loyaltyPoints: 5,
                refundWindow: 1 days,
                metadataHash: keccak256("fork-product"),
                passUri: "ipfs://opentab/fork-product"
            })
        );
        vm.prank(merchant);
        checkout.setProductActive(productId, true);

        uint64 validAfter = uint64(block.timestamp);
        uint64 validUntil = validAfter + 15 minutes;
        uint256 amount = 1_000_000;
        OpenTabCheckout.OrderIntent memory intent = OpenTabCheckout.OrderIntent({
            orderKey: keccak256("fork-order"),
            payer: payer,
            recipient: payer,
            merchantId: merchantId,
            productId: productId,
            productVersion: 1,
            token: ARBITRUM_ONE_USDC,
            amount: amount,
            platformFeeBps: FEE_BPS,
            platformFee: Math.mulDiv(amount, FEE_BPS, 10_000),
            quantity: 1,
            validAfter: validAfter,
            validUntil: validUntil,
            refundDeadline: validUntil + 1 days,
            metadataHash: keccak256("fork-product")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_SIGNER_KEY, checkout.hashOrderIntent(intent));
        bytes memory signature = abi.encodePacked(r, s, v);

        deal(ARBITRUM_ONE_USDC, payer, amount, true);
        vm.prank(payer);
        IERC20Metadata(ARBITRUM_ONE_USDC).approve(address(checkout), amount);
        vm.prank(payer);
        checkout.pay(intent, signature);

        assertEq(IERC20Metadata(ARBITRUM_ONE_USDC).balanceOf(address(checkout)), amount);
        assertEq(checkout.totalLiability(), amount);
        assertEq(pass.balanceOf(payer, productId), 1);
    }
}
