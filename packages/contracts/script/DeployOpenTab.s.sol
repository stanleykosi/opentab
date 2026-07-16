// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OpenTabCheckout} from "../src/OpenTabCheckout.sol";
import {OpenTabPass1155} from "../src/OpenTabPass1155.sol";
import {OpenTabSplitReimbursement} from "../src/OpenTabSplitReimbursement.sol";

/// @notice Guarded OpenTab deployment for Arbitrum One or Arbitrum Sepolia.
contract DeployOpenTab is Script {
    uint256 public constant ARBITRUM_ONE_CHAIN_ID = 42_161;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    address public constant ARBITRUM_ONE_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant ARBITRUM_SEPOLIA_USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    struct DeploymentConfig {
        uint256 expectedChainId;
        address usdc;
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
    }

    event DeploymentCompleted(
        uint256 indexed chainId,
        address indexed checkout,
        address indexed pass,
        address splitReimbursement,
        address usdc,
        address admin
    );

    function run() external returns (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split) {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        DeploymentConfig memory config = _configFromEnvironment();
        _validateConfig(config, deployer);

        // Signing is delegated to the reviewed CLI wallet. No plaintext key is
        // loaded into the script environment.
        vm.startBroadcast(deployer);
        (checkout, pass, split) = _deployContracts(config, deployer);
        pass.bindCheckout(address(checkout));
        vm.stopBroadcast();

        _verifyDeployment(config, deployer, checkout, pass, split);
        emit DeploymentCompleted(
            block.chainid, address(checkout), address(pass), address(split), config.usdc, config.admin
        );
    }

    function canonicalUsdc(uint256 chainId) public pure returns (address) {
        if (chainId == ARBITRUM_ONE_CHAIN_ID) return ARBITRUM_ONE_USDC;
        if (chainId == ARBITRUM_SEPOLIA_CHAIN_ID) return ARBITRUM_SEPOLIA_USDC;
        revert("unsupported chain");
    }

    function _deployContracts(DeploymentConfig memory config, address deployer)
        internal
        returns (OpenTabCheckout checkout, OpenTabPass1155 pass, OpenTabSplitReimbursement split)
    {
        _validateConfig(config, deployer);
        pass = new OpenTabPass1155(config.admin, config.adminDelay, deployer);
        checkout = new OpenTabCheckout(
            IERC20Metadata(config.usdc),
            pass,
            config.admin,
            config.adminDelay,
            config.pauser,
            config.feeManager,
            config.merchantManager,
            config.orderSigner,
            config.feeRecipient,
            config.platformFeeBps
        );
        split = new OpenTabSplitReimbursement(
            IERC20Metadata(config.usdc), config.admin, config.adminDelay, config.pauser, config.splitSigner
        );
    }

    function _validateConfig(DeploymentConfig memory config, address deployer) internal view {
        require(config.expectedChainId == block.chainid, "unexpected chain");
        require(config.usdc == canonicalUsdc(config.expectedChainId), "non-canonical USDC");
        require(config.usdc.code.length != 0, "USDC has no code");
        require(IERC20Metadata(config.usdc).decimals() == 6, "USDC decimals not six");
        require(deployer != address(0), "zero deployer");
        require(config.admin != address(0) && config.admin != deployer, "admin/deployer separation");
        require(config.adminDelay != 0, "zero admin delay");
        require(config.pauser != address(0), "zero pauser");
        require(config.feeManager != address(0), "zero fee manager");
        require(config.merchantManager != address(0), "zero merchant manager");
        require(config.orderSigner != address(0), "zero order signer");
        require(config.splitSigner != address(0), "zero split signer");
        require(config.sponsorSigner != address(0), "zero sponsor signer");
        require(config.feeRecipient != address(0), "zero fee recipient");
        require(config.platformFeeBps <= 500, "fee exceeds cap");

        address[9] memory securityBoundaries = [
            deployer,
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
            for (uint256 j = i + 1; j < securityBoundaries.length; ++j) {
                require(securityBoundaries[i] != securityBoundaries[j], "security boundary reuse");
            }
        }
    }

    function _verifyDeployment(
        DeploymentConfig memory config,
        address deployer,
        OpenTabCheckout checkout,
        OpenTabPass1155 pass,
        OpenTabSplitReimbursement split
    ) internal view {
        require(address(checkout.USDC()) == config.usdc, "checkout USDC mismatch");
        require(address(checkout.PASS()) == address(pass), "checkout pass mismatch");
        require(address(split.USDC()) == config.usdc, "split USDC mismatch");
        require(pass.checkout() == address(checkout), "pass binding mismatch");
        require(checkout.hasRole(checkout.DEFAULT_ADMIN_ROLE(), config.admin), "checkout admin missing");
        require(pass.hasRole(pass.DEFAULT_ADMIN_ROLE(), config.admin), "pass admin missing");
        require(split.hasRole(split.DEFAULT_ADMIN_ROLE(), config.admin), "split admin missing");
        require(checkout.hasRole(checkout.PAUSER_ROLE(), config.pauser), "checkout pauser missing");
        require(split.hasRole(split.PAUSER_ROLE(), config.pauser), "split pauser missing");
        require(checkout.hasRole(checkout.FEE_MANAGER_ROLE(), config.feeManager), "fee manager missing");
        require(checkout.hasRole(checkout.MERCHANT_MANAGER_ROLE(), config.merchantManager), "merchant manager missing");
        require(checkout.hasRole(checkout.ORDER_SIGNER_ROLE(), config.orderSigner), "order signer missing");
        require(split.hasRole(split.SPLIT_SIGNER_ROLE(), config.splitSigner), "split signer missing");
        require(!checkout.hasRole(checkout.DEFAULT_ADMIN_ROLE(), deployer), "deployer is checkout admin");
        require(!pass.hasRole(pass.DEFAULT_ADMIN_ROLE(), deployer), "deployer is pass admin");
        require(!split.hasRole(split.DEFAULT_ADMIN_ROLE(), deployer), "deployer is split admin");
        require(!checkout.hasRole(checkout.PAUSER_ROLE(), config.sponsorSigner), "sponsor is checkout pauser");
        require(!checkout.hasRole(checkout.FEE_MANAGER_ROLE(), config.sponsorSigner), "sponsor is fee manager");
        require(
            !checkout.hasRole(checkout.MERCHANT_MANAGER_ROLE(), config.sponsorSigner), "sponsor is merchant manager"
        );
        require(!checkout.hasRole(checkout.ORDER_SIGNER_ROLE(), config.sponsorSigner), "sponsor is order signer");
        require(!split.hasRole(split.PAUSER_ROLE(), config.sponsorSigner), "sponsor is split pauser");
        require(!split.hasRole(split.SPLIT_SIGNER_ROLE(), config.sponsorSigner), "sponsor is split signer");
        require(pass.hasRole(pass.MINTER_ROLE(), address(checkout)), "pass minter missing");
        require(pass.hasRole(pass.BURNER_ROLE(), address(checkout)), "pass burner missing");
        require(pass.hasRole(pass.CONFIGURATOR_ROLE(), address(checkout)), "pass configurator missing");
        require(pass.getRoleAdmin(pass.MINTER_ROLE()) != pass.DEFAULT_ADMIN_ROLE(), "pass minter admin unlocked");
        require(checkout.defaultAdminDelay() == config.adminDelay, "checkout admin delay mismatch");
        require(pass.defaultAdminDelay() == config.adminDelay, "pass admin delay mismatch");
        require(split.defaultAdminDelay() == config.adminDelay, "split admin delay mismatch");
        require(checkout.feeRecipient() == config.feeRecipient, "fee recipient mismatch");
        require(checkout.platformFeeBps() == config.platformFeeBps, "platform fee mismatch");
        require(!checkout.paused(), "checkout unexpectedly paused");
        require(!split.paused(), "split unexpectedly paused");
    }

    function _configFromEnvironment() internal view returns (DeploymentConfig memory config) {
        uint256 rawAdminDelay = vm.envUint("ADMIN_DELAY_SECONDS");
        uint256 rawFeeBps = vm.envUint("PLATFORM_FEE_BPS");
        require(rawAdminDelay <= type(uint48).max, "admin delay overflow");
        require(rawFeeBps <= type(uint16).max, "fee bps overflow");
        config = DeploymentConfig({
            expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
            usdc: vm.envAddress("USDC_ADDRESS"),
            admin: vm.envAddress("ADMIN_ADDRESS"),
            adminDelay: uint48(rawAdminDelay),
            pauser: vm.envAddress("PAUSER_ADDRESS"),
            feeManager: vm.envAddress("FEE_MANAGER_ADDRESS"),
            merchantManager: vm.envAddress("MERCHANT_MANAGER_ADDRESS"),
            orderSigner: vm.envAddress("ORDER_SIGNER_ADDRESS"),
            splitSigner: vm.envAddress("SPLIT_SIGNER_ADDRESS"),
            sponsorSigner: vm.envAddress("SPONSOR_SIGNER_ADDRESS"),
            feeRecipient: vm.envAddress("FEE_RECIPIENT_ADDRESS"),
            platformFeeBps: uint16(rawFeeBps)
        });
    }
}
