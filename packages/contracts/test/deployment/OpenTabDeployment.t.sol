// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";
import {OpenTabSplitReimbursement} from "../../src/OpenTabSplitReimbursement.sol";
import {DeployOpenTab} from "../../script/DeployOpenTab.s.sol";
import {VerifyDeployment} from "../../script/VerifyDeployment.s.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract DeployOpenTabHarness is DeployOpenTab {
    function deployForTest(DeploymentConfig memory config, address deployer)
        external
        returns (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split)
    {
        (checkout, pass, split) = _deployContracts(config, deployer);
        vm.prank(deployer);
        pass.bindCheckout(address(checkout));
        _verifyDeployment(config, deployer, checkout, pass, split);
    }

    function validateForTest(DeploymentConfig memory config, address deployer) external view {
        _validateConfig(config, deployer);
    }
}

contract VerifyDeploymentHarness is VerifyDeployment {
    function verifyForTest(VerificationConfig memory config) external view {
        _verify(config);
    }
}

contract OpenTabDeploymentTest is Test {
    address internal constant SEPOLIA_USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    DeployOpenTabHarness internal deployerScript;
    VerifyDeploymentHarness internal verifierScript;
    DeployOpenTab.DeploymentConfig internal config;
    address internal deployer;

    function setUp() public {
        vm.chainId(421_614);
        MockUSDC mock = new MockUSDC();
        vm.etch(SEPOLIA_USDC, address(mock).code);
        deployer = makeAddr("deployment-operator");
        deployerScript = new DeployOpenTabHarness();
        verifierScript = new VerifyDeploymentHarness();
        config = DeployOpenTab.DeploymentConfig({
            expectedChainId: 421_614,
            usdc: SEPOLIA_USDC,
            admin: makeAddr("safe-admin"),
            adminDelay: 2 days,
            pauser: makeAddr("deployment-pauser"),
            feeManager: makeAddr("deployment-fee-manager"),
            merchantManager: makeAddr("deployment-merchant-manager"),
            orderSigner: makeAddr("deployment-order-signer"),
            splitSigner: makeAddr("deployment-split-signer"),
            sponsorSigner: makeAddr("deployment-sponsor-signer"),
            feeRecipient: makeAddr("deployment-fee-recipient"),
            platformFeeBps: 250
        });
    }

    function _verificationConfig(OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split)
        internal
        view
        returns (VerifyDeployment.VerificationConfig memory)
    {
        return VerifyDeployment.VerificationConfig({
            expectedChainId: config.expectedChainId,
            usdc: config.usdc,
            checkout: address(checkout),
            pass: address(pass),
            split: address(split),
            deployer: deployer,
            admin: config.admin,
            adminDelay: config.adminDelay,
            pauser: config.pauser,
            feeManager: config.feeManager,
            merchantManager: config.merchantManager,
            orderSigner: config.orderSigner,
            splitSigner: config.splitSigner,
            sponsorSigner: config.sponsorSigner,
            feeRecipient: config.feeRecipient,
            platformFeeBps: config.platformFeeBps,
            checkoutRuntimeCodeHash: address(checkout).codehash,
            passRuntimeCodeHash: address(pass).codehash,
            splitRuntimeCodeHash: address(split).codehash
        });
    }

    function testDryRunDeploysAndLocksExpectedRoles() public {
        (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split) =
            deployerScript.deployForTest(config, deployer);

        assertEq(address(checkout.USDC()), SEPOLIA_USDC);
        assertEq(address(split.USDC()), SEPOLIA_USDC);
        assertEq(pass.checkout(), address(checkout));
        assertTrue(checkout.hasRole(checkout.DEFAULT_ADMIN_ROLE(), config.admin));
        assertTrue(pass.hasRole(pass.DEFAULT_ADMIN_ROLE(), config.admin));
        assertTrue(split.hasRole(split.DEFAULT_ADMIN_ROLE(), config.admin));
        assertTrue(checkout.hasRole(checkout.PAUSER_ROLE(), config.pauser));
        assertTrue(checkout.hasRole(checkout.FEE_MANAGER_ROLE(), config.feeManager));
        assertTrue(checkout.hasRole(checkout.MERCHANT_MANAGER_ROLE(), config.merchantManager));
        assertTrue(checkout.hasRole(checkout.ORDER_SIGNER_ROLE(), config.orderSigner));
        assertTrue(split.hasRole(split.PAUSER_ROLE(), config.pauser));
        assertTrue(split.hasRole(split.SPLIT_SIGNER_ROLE(), config.splitSigner));
        assertTrue(pass.hasRole(pass.MINTER_ROLE(), address(checkout)));
        assertTrue(pass.getRoleAdmin(pass.MINTER_ROLE()) != pass.DEFAULT_ADMIN_ROLE());
        assertEq(checkout.defaultAdminDelay(), config.adminDelay);
        assertEq(checkout.feeRecipient(), config.feeRecipient);
        assertEq(checkout.platformFeeBps(), config.platformFeeBps);
        assertFalse(checkout.paused());
        assertFalse(split.paused());
    }

    function testValidationRejectsWrongChainTokenOperatorAndFee() public {
        DeployOpenTab.DeploymentConfig memory candidate = config;
        candidate.expectedChainId = 42_161;
        vm.expectRevert(bytes("unexpected chain"));
        deployerScript.validateForTest(candidate, deployer);

        candidate = config;
        candidate.usdc = address(new MockUSDC());
        vm.expectRevert(bytes("non-canonical USDC"));
        deployerScript.validateForTest(candidate, deployer);

        vm.expectRevert(bytes("admin/deployer separation"));
        deployerScript.validateForTest(config, config.admin);

        candidate = config;
        candidate.platformFeeBps = 501;
        vm.expectRevert(bytes("fee exceeds cap"));
        deployerScript.validateForTest(candidate, deployer);
    }

    function testValidationRejectsAnySecurityBoundaryReuse() public {
        DeployOpenTab.DeploymentConfig memory candidate = config;
        candidate.pauser = deployer;
        vm.expectRevert(bytes("security boundary reuse"));
        deployerScript.validateForTest(candidate, deployer);

        candidate = config;
        candidate.feeManager = config.admin;
        vm.expectRevert(bytes("security boundary reuse"));
        deployerScript.validateForTest(candidate, deployer);

        candidate = config;
        candidate.merchantManager = config.pauser;
        vm.expectRevert(bytes("security boundary reuse"));
        deployerScript.validateForTest(candidate, deployer);

        candidate = config;
        candidate.orderSigner = config.splitSigner;
        vm.expectRevert(bytes("security boundary reuse"));
        deployerScript.validateForTest(candidate, deployer);

        candidate = config;
        candidate.sponsorSigner = config.feeRecipient;
        vm.expectRevert(bytes("security boundary reuse"));
        deployerScript.validateForTest(candidate, deployer);
    }

    function testKeylessVerifierChecksFullLaunchConfiguration() public {
        (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split) =
            deployerScript.deployForTest(config, deployer);

        verifierScript.verifyForTest(_verificationConfig(checkout, pass, split));
    }

    function testKeylessVerifierRejectsCodeHashRoleFeeDelayAndPauseDrift() public {
        (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split) =
            deployerScript.deployForTest(config, deployer);
        VerifyDeployment.VerificationConfig memory candidate = _verificationConfig(checkout, pass, split);

        candidate.checkoutRuntimeCodeHash = keccak256("wrong code");
        vm.expectRevert(bytes("checkout code hash mismatch"));
        verifierScript.verifyForTest(candidate);

        candidate = _verificationConfig(checkout, pass, split);
        candidate.orderSigner = makeAddr("unexpected-order-signer");
        vm.expectRevert(bytes("order signer missing"));
        verifierScript.verifyForTest(candidate);

        candidate = _verificationConfig(checkout, pass, split);
        candidate.platformFeeBps += 1;
        vm.expectRevert(bytes("platform fee mismatch"));
        verifierScript.verifyForTest(candidate);

        candidate = _verificationConfig(checkout, pass, split);
        candidate.adminDelay += 1;
        vm.expectRevert(bytes("checkout admin delay mismatch"));
        verifierScript.verifyForTest(candidate);

        vm.prank(config.pauser);
        checkout.pause();
        vm.expectRevert(bytes("checkout paused"));
        verifierScript.verifyForTest(_verificationConfig(checkout, pass, split));
    }

    function testKeylessVerifierRejectsSponsorPrivilege() public {
        (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split) =
            deployerScript.deployForTest(config, deployer);
        bytes32 orderSignerRole = checkout.ORDER_SIGNER_ROLE();
        vm.prank(config.admin);
        checkout.grantRole(orderSignerRole, config.sponsorSigner);

        vm.expectRevert(bytes("sponsor has privilege"));
        verifierScript.verifyForTest(_verificationConfig(checkout, pass, split));
    }

    function testKeylessVerifierRejectsPendingAdminChange() public {
        (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split) =
            deployerScript.deployForTest(config, deployer);
        address replacementAdmin = makeAddr("unaccepted-admin");
        vm.prank(config.admin);
        checkout.beginDefaultAdminTransfer(replacementAdmin);

        vm.expectRevert(bytes("pending admin transfer"));
        verifierScript.verifyForTest(_verificationConfig(checkout, pass, split));
    }
}
