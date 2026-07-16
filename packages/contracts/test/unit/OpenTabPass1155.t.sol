// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {OpenTabPass1155} from "../../src/OpenTabPass1155.sol";

contract PassCheckoutHarness {
    function configure(OpenTabPass1155 pass, uint256 productId, string calldata metadataUri) external {
        pass.configureProduct(productId, metadataUri);
    }

    function mint(OpenTabPass1155 pass, address account, uint256 productId, uint256 quantity) external {
        pass.mint(account, productId, quantity, "");
    }

    function burn(OpenTabPass1155 pass, address account, uint256 productId, uint256 quantity, bytes32 orderKey)
        external
    {
        pass.burn(account, productId, quantity, orderKey);
    }
}

contract OpenTabPass1155Test is Test {
    address private admin = makeAddr("admin");
    address private holder = makeAddr("holder");
    address private other = makeAddr("other");
    PassCheckoutHarness private harness;
    OpenTabPass1155 private pass;

    function setUp() external {
        harness = new PassCheckoutHarness();
        pass = new OpenTabPass1155(admin, 1 days, address(this));
        pass.bindCheckout(address(harness));
    }

    function testBindGrantsOnlyCheckoutRoles() external view {
        assertEq(pass.checkout(), address(harness));
        assertTrue(pass.hasRole(pass.MINTER_ROLE(), address(harness)));
        assertTrue(pass.hasRole(pass.BURNER_ROLE(), address(harness)));
        assertTrue(pass.hasRole(pass.CONFIGURATOR_ROLE(), address(harness)));
        assertFalse(pass.hasRole(pass.MINTER_ROLE(), address(this)));
        assertEq(pass.defaultAdmin(), admin);
    }

    function testCannotBindTwice() external {
        vm.expectRevert(abi.encodeWithSelector(OpenTabPass1155.UnauthorizedBootstrap.selector, address(this)));
        pass.bindCheckout(address(harness));
    }

    function testConfigureMintAndBurn() external {
        harness.configure(pass, 7, "ipfs://pass/7");
        harness.mint(pass, holder, 7, 2);
        assertEq(pass.uri(7), "ipfs://pass/7");
        assertEq(pass.balanceOf(holder, 7), 2);
        assertEq(pass.totalSupply(7), 2);

        harness.burn(pass, holder, 7, 2, keccak256("order"));
        assertEq(pass.balanceOf(holder, 7), 0);
        assertEq(pass.totalSupply(7), 0);
    }

    function testUnauthorizedCannotMintOrConfigureOrBurn() external {
        bytes32 role = pass.MINTER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), role)
        );
        pass.mint(holder, 1, 1, "");

        role = pass.CONFIGURATOR_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), role)
        );
        pass.configureProduct(1, "ipfs://bad");

        role = pass.BURNER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), role)
        );
        pass.burn(holder, 1, 1, bytes32(uint256(1)));
    }

    function testDefaultAdminCannotAddOrRemoveCheckoutCapabilitiesAfterBinding() external {
        address attacker = makeAddr("extraMinter");
        bytes32 minterRole = pass.MINTER_ROLE();
        bytes32 lockedAdmin = pass.getRoleAdmin(minterRole);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, lockedAdmin)
        );
        vm.prank(admin);
        pass.grantRole(minterRole, attacker);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, lockedAdmin)
        );
        vm.prank(admin);
        pass.revokeRole(minterRole, address(harness));

        assertFalse(pass.hasRole(minterRole, attacker));
        assertTrue(pass.hasRole(minterRole, address(harness)));
    }

    function testPassCannotTransferOrApprove() external {
        harness.mint(pass, holder, 1, 1);

        vm.expectRevert(OpenTabPass1155.PassNonTransferable.selector);
        vm.prank(holder);
        pass.safeTransferFrom(holder, other, 1, 1, "");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = 1;
        amounts[0] = 1;
        vm.expectRevert(OpenTabPass1155.PassNonTransferable.selector);
        vm.prank(holder);
        pass.safeBatchTransferFrom(holder, other, ids, amounts, "");

        vm.expectRevert(OpenTabPass1155.PassNonTransferable.selector);
        vm.prank(holder);
        pass.setApprovalForAll(other, true);

        assertEq(pass.balanceOf(holder, 1), 1);
        assertEq(pass.balanceOf(other, 1), 0);
    }

    function testConstructorAndBindRejectInvalidAddresses() external {
        vm.expectRevert(OpenTabPass1155.ZeroAddress.selector);
        new OpenTabPass1155(admin, 1 days, address(0));

        OpenTabPass1155 unbound = new OpenTabPass1155(admin, 1 days, address(this));
        vm.expectRevert(OpenTabPass1155.ZeroAddress.selector);
        unbound.bindCheckout(address(0));
    }
}
