// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IOpenTabPass
/// @notice Narrow checkout-facing interface for OpenTab's non-transferable pass.
interface IOpenTabPass {
    /// @notice Configures the metadata URI for one product/pass token identifier.
    function configureProduct(uint256 productId, string calldata metadataUri) external;

    /// @notice Mints a purchased product/pass quantity to its receipt holder.
    function mint(address account, uint256 productId, uint256 quantity, bytes calldata data) external;

    /// @notice Burns a fully refunded order's product/pass quantity.
    function burn(address account, uint256 productId, uint256 quantity, bytes32 orderKey) external;
}
