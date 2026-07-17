// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../src/OpenTabPass1155.sol";
import {OpenTabSplitReimbursement} from "../src/OpenTabSplitReimbursement.sol";

/// @notice Keyless, read-only assertion of an OpenTab deployment and its launch configuration.
/// @dev Expected runtime hashes and identities come from the reviewed deployment attestation. This
///      script independently reads every corresponding value from the selected Arbitrum network.
contract VerifyDeployment is Script {
    uint256 public constant ARBITRUM_ONE_CHAIN_ID = 42_161;
    address public constant ARBITRUM_ONE_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    struct VerificationConfig {
        uint256 expectedChainId;
        address usdc;
        address checkout;
        address pass;
        address split;
        address deployer;
        address admin;
        uint48 adminDelay;
        address pauser;
        address feeManager;
        address merchantManager;
        address orderSigner;
        address splitSigner;
        address sponsorSigner;
        address feeRecipient;
        uint16 platformFeeBps;
        bytes32 checkoutRuntimeCodeHash;
        bytes32 passRuntimeCodeHash;
        bytes32 splitRuntimeCodeHash;
    }

    function run() external view {
        _verify(_configFromEnvironment());
    }

    function canonicalUsdc(uint256 chainId) public pure returns (address) {
        if (chainId == ARBITRUM_ONE_CHAIN_ID) return ARBITRUM_ONE_USDC;
        revert("unsupported chain");
    }

    function _verify(VerificationConfig memory config) internal view {
        require(config.expectedChainId == block.chainid, "unexpected chain");
        require(config.usdc == canonicalUsdc(config.expectedChainId), "non-canonical USDC");
        require(config.usdc.code.length != 0, "USDC has no code");
        require(IERC20Metadata(config.usdc).decimals() == 6, "USDC decimals not six");
        _verifySecurityBoundarySeparation(config);
        _verifyContractAddressesAndCode(config);

        OpenTabCheckout checkout = OpenTabCheckout(config.checkout);
        OpenTabPass1155 pass = OpenTabPass1155(config.pass);
        OpenTabSplitReimbursement split = OpenTabSplitReimbursement(config.split);

        require(address(checkout.USDC()) == config.usdc, "checkout USDC mismatch");
        require(address(checkout.PASS()) == config.pass, "checkout pass mismatch");
        require(address(split.USDC()) == config.usdc, "split USDC mismatch");
        require(pass.checkout() == config.checkout, "pass binding mismatch");

        require(checkout.defaultAdmin() == config.admin, "checkout admin mismatch");
        require(pass.defaultAdmin() == config.admin, "pass admin mismatch");
        require(split.defaultAdmin() == config.admin, "split admin mismatch");
        require(checkout.defaultAdminDelay() == config.adminDelay, "checkout admin delay mismatch");
        require(pass.defaultAdminDelay() == config.adminDelay, "pass admin delay mismatch");
        require(split.defaultAdminDelay() == config.adminDelay, "split admin delay mismatch");
        _verifyNoPendingAdminChange(IAccessControlDefaultAdminRules(config.checkout));
        _verifyNoPendingAdminChange(IAccessControlDefaultAdminRules(config.pass));
        _verifyNoPendingAdminChange(IAccessControlDefaultAdminRules(config.split));

        require(checkout.hasRole(checkout.PAUSER_ROLE(), config.pauser), "checkout pauser missing");
        require(split.hasRole(split.PAUSER_ROLE(), config.pauser), "split pauser missing");
        require(checkout.hasRole(checkout.FEE_MANAGER_ROLE(), config.feeManager), "fee manager missing");
        require(checkout.hasRole(checkout.MERCHANT_MANAGER_ROLE(), config.merchantManager), "merchant manager missing");
        require(checkout.hasRole(checkout.ORDER_SIGNER_ROLE(), config.orderSigner), "order signer missing");
        require(split.hasRole(split.SPLIT_SIGNER_ROLE(), config.splitSigner), "split signer missing");
        _verifyUnprivilegedBoundary(checkout, split, pass, config.deployer, "deployer has privilege");
        _verifyUnprivilegedBoundary(checkout, split, pass, config.sponsorSigner, "sponsor has privilege");

        require(checkout.feeRecipient() == config.feeRecipient, "fee recipient mismatch");
        require(checkout.platformFeeBps() == config.platformFeeBps, "platform fee mismatch");
        require(checkout.MAX_PLATFORM_FEE_BPS() == 500, "unexpected fee cap");
        require(!checkout.paused(), "checkout paused");
        require(!split.paused(), "split paused");

        bytes32 lockedAdmin = pass.getRoleAdmin(pass.MINTER_ROLE());
        require(pass.hasRole(pass.MINTER_ROLE(), config.checkout), "pass minter missing");
        require(pass.hasRole(pass.BURNER_ROLE(), config.checkout), "pass burner missing");
        require(pass.hasRole(pass.CONFIGURATOR_ROLE(), config.checkout), "pass configurator missing");
        require(lockedAdmin != pass.DEFAULT_ADMIN_ROLE(), "pass roles unlocked");
        require(pass.getRoleAdmin(pass.BURNER_ROLE()) == lockedAdmin, "pass burner admin mismatch");
        require(pass.getRoleAdmin(pass.CONFIGURATOR_ROLE()) == lockedAdmin, "pass configurator admin mismatch");

        require(keccak256(bytes(checkout.CONTRACT_VERSION())) == keccak256("1.0.0"), "checkout version mismatch");
        require(keccak256(bytes(pass.CONTRACT_VERSION())) == keccak256("1.0.0"), "pass version mismatch");
        require(keccak256(bytes(split.CONTRACT_VERSION())) == keccak256("1.0.0"), "split version mismatch");
        _verifyDomain(config.checkout, "OpenTab Order Intent", config.expectedChainId);
        _verifyDomain(config.split, "OpenTab Split Reimbursement", config.expectedChainId);
    }

    function _verifyContractAddressesAndCode(VerificationConfig memory config) private view {
        require(config.checkout != address(0) && config.checkout.code.length != 0, "checkout has no code");
        require(config.pass != address(0) && config.pass.code.length != 0, "pass has no code");
        require(config.split != address(0) && config.split.code.length != 0, "split has no code");
        require(
            config.checkout != config.pass && config.checkout != config.split && config.pass != config.split,
            "contract address reuse"
        );
        require(config.checkoutRuntimeCodeHash != bytes32(0), "zero checkout code hash");
        require(config.passRuntimeCodeHash != bytes32(0), "zero pass code hash");
        require(config.splitRuntimeCodeHash != bytes32(0), "zero split code hash");
        require(config.checkout.codehash == config.checkoutRuntimeCodeHash, "checkout code hash mismatch");
        require(config.pass.codehash == config.passRuntimeCodeHash, "pass code hash mismatch");
        require(config.split.codehash == config.splitRuntimeCodeHash, "split code hash mismatch");
    }

    function _verifySecurityBoundarySeparation(VerificationConfig memory config) private pure {
        require(config.adminDelay != 0, "zero admin delay");
        require(config.platformFeeBps <= 500, "fee exceeds cap");
        address[9] memory securityBoundaries = [
            config.deployer,
            config.admin,
            config.pauser,
            config.feeManager,
            config.merchantManager,
            config.orderSigner,
            config.splitSigner,
            config.sponsorSigner,
            config.feeRecipient
        ];
        for (uint256 i = 0; i < securityBoundaries.length; ++i) {
            require(securityBoundaries[i] != address(0), "zero security boundary");
            for (uint256 j = i + 1; j < securityBoundaries.length; ++j) {
                require(securityBoundaries[i] != securityBoundaries[j], "security boundary reuse");
            }
        }
    }

    function _verifyUnprivilegedBoundary(
        OpenTabCheckout checkout,
        OpenTabSplitReimbursement split,
        OpenTabPass1155 pass,
        address account,
        string memory message
    ) private view {
        require(!checkout.hasRole(checkout.DEFAULT_ADMIN_ROLE(), account), message);
        require(!checkout.hasRole(checkout.PAUSER_ROLE(), account), message);
        require(!checkout.hasRole(checkout.FEE_MANAGER_ROLE(), account), message);
        require(!checkout.hasRole(checkout.MERCHANT_MANAGER_ROLE(), account), message);
        require(!checkout.hasRole(checkout.ORDER_SIGNER_ROLE(), account), message);
        require(!split.hasRole(split.DEFAULT_ADMIN_ROLE(), account), message);
        require(!split.hasRole(split.PAUSER_ROLE(), account), message);
        require(!split.hasRole(split.SPLIT_SIGNER_ROLE(), account), message);
        require(!pass.hasRole(pass.DEFAULT_ADMIN_ROLE(), account), message);
        require(!pass.hasRole(pass.MINTER_ROLE(), account), message);
        require(!pass.hasRole(pass.BURNER_ROLE(), account), message);
        require(!pass.hasRole(pass.CONFIGURATOR_ROLE(), account), message);
    }

    function _verifyDomain(address target, string memory expectedName, uint256 expectedChainId) private view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 domainChainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = IERC5267(target).eip712Domain();
        require(fields == 0x0f, "domain fields mismatch");
        require(keccak256(bytes(name)) == keccak256(bytes(expectedName)), "domain name mismatch");
        require(keccak256(bytes(version)) == keccak256("1"), "domain version mismatch");
        require(domainChainId == expectedChainId, "domain chain mismatch");
        require(verifyingContract == target, "domain contract mismatch");
        require(salt == bytes32(0) && extensions.length == 0, "unexpected domain extension");
    }

    function _verifyNoPendingAdminChange(IAccessControlDefaultAdminRules target) private view {
        (address pendingAdmin, uint48 adminSchedule) = target.pendingDefaultAdmin();
        (uint48 pendingDelay, uint48 delaySchedule) = target.pendingDefaultAdminDelay();
        require(pendingAdmin == address(0) && adminSchedule == 0, "pending admin transfer");
        require(pendingDelay == 0 && delaySchedule == 0, "pending admin delay change");
    }

    function _configFromEnvironment() private view returns (VerificationConfig memory config) {
        uint256 rawAdminDelay = vm.envUint("ADMIN_DELAY_SECONDS");
        uint256 rawFeeBps = vm.envUint("PLATFORM_FEE_BPS");
        require(rawAdminDelay <= type(uint48).max, "admin delay overflow");
        require(rawFeeBps <= type(uint16).max, "fee bps overflow");
        config = VerificationConfig({
            expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
            usdc: vm.envAddress("USDC_ADDRESS"),
            checkout: vm.envAddress("CHECKOUT_ADDRESS"),
            pass: vm.envAddress("PASS_ADDRESS"),
            split: vm.envAddress("SPLIT_REIMBURSEMENT_ADDRESS"),
            deployer: vm.envAddress("DEPLOYER_ADDRESS"),
            admin: vm.envAddress("ADMIN_ADDRESS"),
            adminDelay: uint48(rawAdminDelay),
            pauser: vm.envAddress("PAUSER_ADDRESS"),
            feeManager: vm.envAddress("FEE_MANAGER_ADDRESS"),
            merchantManager: vm.envAddress("MERCHANT_MANAGER_ADDRESS"),
            orderSigner: vm.envAddress("ORDER_SIGNER_ADDRESS"),
            splitSigner: vm.envAddress("SPLIT_SIGNER_ADDRESS"),
            sponsorSigner: vm.envAddress("SPONSOR_SIGNER_ADDRESS"),
            feeRecipient: vm.envAddress("FEE_RECIPIENT_ADDRESS"),
            platformFeeBps: uint16(rawFeeBps),
            checkoutRuntimeCodeHash: vm.envBytes32("CHECKOUT_RUNTIME_CODE_HASH"),
            passRuntimeCodeHash: vm.envBytes32("PASS_RUNTIME_CODE_HASH"),
            splitRuntimeCodeHash: vm.envBytes32("SPLIT_RUNTIME_CODE_HASH")
        });
    }
}
