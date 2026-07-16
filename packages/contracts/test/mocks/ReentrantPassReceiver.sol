// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {OpenTabCheckout} from "../../src/OpenTabCheckout.sol";

contract ReentrantPassReceiver is IERC1155Receiver {
    OpenTabCheckout public immutable checkout;
    bytes32 public orderKey;
    bool public reentryBlocked;

    constructor(OpenTabCheckout checkout_) {
        checkout = checkout_;
    }

    function arm(bytes32 orderKey_) external {
        orderKey = orderKey_;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        try checkout.refund(orderKey, 1) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}

/// @dev Models a code-bearing account/delegate that does not implement ERC-1155 receipt hooks.
contract RejectingPassReceiver {}
