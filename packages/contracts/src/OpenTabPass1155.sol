// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {IOpenTabPass} from "./interfaces/IOpenTabPass.sol";

/// @title OpenTabPass1155
/// @notice Non-transferable product receipts and event passes minted atomically by OpenTabCheckout.
/// @dev Token IDs equal OpenTab product IDs. A one-time bootstrap binding removes the deployer's
///      temporary authority as soon as the checkout is deployed.
contract OpenTabPass1155 is ERC1155Supply, AccessControlDefaultAdminRules, IOpenTabPass {
    string public constant CONTRACT_VERSION = "1.0.0";

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant CONFIGURATOR_ROLE = keccak256("CONFIGURATOR_ROLE");
    bytes32 private constant _LOCKED_ROLE_ADMIN = keccak256("LOCKED_ROLE_ADMIN");

    error ZeroAddress();
    error InvalidProductId();
    error InvalidQuantity();
    error CheckoutAlreadyBound(address checkout);
    error UnauthorizedBootstrap(address caller);
    error PassNonTransferable();

    event CheckoutBound(address indexed checkout, address indexed bootstrapper);
    event ProductPassConfigured(uint256 indexed productId, uint256 indexed tokenId, string metadataUri);
    event PassRevoked(bytes32 indexed orderKey, address indexed account, uint256 indexed tokenId, uint256 quantity);

    address public checkout;
    address private _bootstrapper;
    mapping(uint256 tokenId => string metadataUri) private _tokenUris;

    constructor(address admin, uint48 adminDelay, address bootstrapper)
        ERC1155("")
        AccessControlDefaultAdminRules(adminDelay, admin)
    {
        if (bootstrapper == address(0)) revert ZeroAddress();
        _bootstrapper = bootstrapper;

        // No account can ever obtain this self-administered role. Once checkout capabilities
        // use it as their admin, even the default admin cannot add a second minter/burner.
        _setRoleAdmin(_LOCKED_ROLE_ADMIN, _LOCKED_ROLE_ADMIN);
    }

    /// @notice Permanently binds the only checkout allowed to configure, mint, and burn passes.
    /// @dev May be called once by the deployment bootstrapper. The bootstrapper is not itself a minter.
    function bindCheckout(address checkout_) external {
        if (msg.sender != _bootstrapper) revert UnauthorizedBootstrap(msg.sender);
        if (checkout != address(0)) revert CheckoutAlreadyBound(checkout);
        if (checkout_ == address(0) || checkout_.code.length == 0) revert ZeroAddress();

        checkout = checkout_;
        delete _bootstrapper;
        _grantRole(MINTER_ROLE, checkout_);
        _grantRole(BURNER_ROLE, checkout_);
        _grantRole(CONFIGURATOR_ROLE, checkout_);
        _setRoleAdmin(MINTER_ROLE, _LOCKED_ROLE_ADMIN);
        _setRoleAdmin(BURNER_ROLE, _LOCKED_ROLE_ADMIN);
        _setRoleAdmin(CONFIGURATOR_ROLE, _LOCKED_ROLE_ADMIN);

        emit CheckoutBound(checkout_, msg.sender);
    }

    /// @inheritdoc ERC1155
    function uri(uint256 tokenId) public view override returns (string memory) {
        return _tokenUris[tokenId];
    }

    /// @notice Sets the metadata URI for a product pass.
    function configureProduct(uint256 productId, string calldata metadataUri)
        external
        override
        onlyRole(CONFIGURATOR_ROLE)
    {
        if (productId == 0) revert InvalidProductId();
        _tokenUris[productId] = metadataUri;
        emit ProductPassConfigured(productId, productId, metadataUri);
    }

    /// @notice Mints purchased quantity to the designated receipt/pass holder.
    function mint(address account, uint256 productId, uint256 quantity, bytes calldata data)
        external
        override
        onlyRole(MINTER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (productId == 0) revert InvalidProductId();
        if (quantity == 0) revert InvalidQuantity();
        _mint(account, productId, quantity, data);
    }

    /// @notice Burns passes when an order is fully refunded.
    function burn(address account, uint256 productId, uint256 quantity, bytes32 orderKey)
        external
        override
        onlyRole(BURNER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (productId == 0) revert InvalidProductId();
        if (quantity == 0) revert InvalidQuantity();
        _burn(account, productId, quantity);
        emit PassRevoked(orderKey, account, productId, quantity);
    }

    /// @dev Approval has no useful meaning for a soulbound pass and is disabled to avoid misleading users.
    function setApprovalForAll(address, bool) public pure override {
        revert PassNonTransferable();
    }

    /// @dev Allows mint and burn only; any nonzero-to-nonzero movement reverts.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155Supply)
    {
        if (from != address(0) && to != address(0)) revert PassNonTransferable();
        super._update(from, to, ids, values);
    }

    /// @inheritdoc ERC1155
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
