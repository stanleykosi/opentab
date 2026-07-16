// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title OpenTabSplitReimbursement
/// @notice Exact, signer-bounded reimbursement transfers that remain financially separate from merchant orders.
contract OpenTabSplitReimbursement is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    string public constant CONTRACT_VERSION = "1.0.0";
    uint64 public constant MAX_INTENT_VALIDITY = 1 days;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SPLIT_SIGNER_ROLE = keccak256("SPLIT_SIGNER_ROLE");
    bytes32 public constant SPLIT_INTENT_TYPEHASH = keccak256(
        "SplitIntent(bytes32 paymentKey,bytes32 splitDigest,bytes32 originalOrderKey,address payer,address beneficiary,address token,uint256 amount,uint64 validAfter,uint64 validUntil,bytes32 metadataHash)"
    );

    struct SplitIntent {
        bytes32 paymentKey;
        bytes32 splitDigest;
        bytes32 originalOrderKey;
        address payer;
        address beneficiary;
        address token;
        uint256 amount;
        uint64 validAfter;
        uint64 validUntil;
        bytes32 metadataHash;
    }

    error ZeroAddress();
    error InvalidContract(address account);
    error InvalidTokenDecimals(uint8 actual);
    error InvalidPaymentKey();
    error InvalidSplitDigest();
    error InvalidOrderKey();
    error InvalidMetadataHash();
    error InvalidAmount();
    error InvalidToken(address token);
    error PaymentKeyConsumed(bytes32 paymentKey);
    error IntentPayerMismatch(address expected, address actual);
    error IntentNotYetValid(uint64 validAfter);
    error IntentExpired(uint64 validUntil);
    error InvalidWindow();
    error IntentValidityTooLong(uint64 validity);
    error InvalidSplitSignature();
    error UnsupportedTokenBehavior(uint256 expected, uint256 actual);

    event SplitPaymentRevoked(bytes32 indexed paymentKey, bytes32 indexed splitDigest, address indexed signer);
    event SplitReimbursed(
        bytes32 indexed paymentKey,
        bytes32 indexed splitDigest,
        bytes32 indexed originalOrderKey,
        address payer,
        address beneficiary,
        address token,
        uint256 amount,
        bytes32 intentDigest
    );

    // Uppercase immutable naming is intentional: this is a deployment-time constant.
    // slither-disable-next-line naming-convention
    IERC20Metadata public immutable USDC;
    mapping(bytes32 paymentKey => bool consumedOrRevoked) public paymentKeyUsed;

    constructor(IERC20Metadata usdc, address admin, uint48 adminDelay, address pauser, address splitSigner)
        AccessControlDefaultAdminRules(adminDelay, admin)
        EIP712("OpenTab Split Reimbursement", "1")
    {
        if (address(usdc) == address(0) || pauser == address(0) || splitSigner == address(0)) {
            revert ZeroAddress();
        }
        if (address(usdc).code.length == 0) revert InvalidContract(address(usdc));
        uint8 decimals = usdc.decimals();
        if (decimals != 6) revert InvalidTokenDecimals(decimals);
        USDC = usdc;
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(SPLIT_SIGNER_ROLE, splitSigner);
    }

    /// @notice Revokes a not-yet-consumed signed payment key.
    function revokePaymentKey(bytes32 paymentKey, bytes32 splitDigest) external onlyRole(SPLIT_SIGNER_ROLE) {
        if (paymentKey == bytes32(0)) revert InvalidPaymentKey();
        if (splitDigest == bytes32(0)) revert InvalidSplitDigest();
        if (paymentKeyUsed[paymentKey]) revert PaymentKeyConsumed(paymentKey);
        paymentKeyUsed[paymentKey] = true;
        emit SplitPaymentRevoked(paymentKey, splitDigest, msg.sender);
    }

    /// @notice Transfers exact USDC from participant to purchaser under a server-signed bounded intent.
    function reimburse(SplitIntent calldata intent, bytes calldata signature) external whenNotPaused nonReentrant {
        bytes32 intentDigest = _validateIntent(intent, signature);
        paymentKeyUsed[intent.paymentKey] = true;

        uint256 beneficiaryBefore = USDC.balanceOf(intent.beneficiary);
        IERC20(address(USDC)).safeTransferFrom(msg.sender, intent.beneficiary, intent.amount);
        uint256 received = USDC.balanceOf(intent.beneficiary) - beneficiaryBefore;
        if (received != intent.amount) revert UnsupportedTokenBehavior(intent.amount, received);

        emit SplitReimbursed(
            intent.paymentKey,
            intent.splitDigest,
            intent.originalOrderKey,
            intent.payer,
            intent.beneficiary,
            intent.token,
            intent.amount,
            intentDigest
        );
    }

    /// @notice Pauses new split reimbursements without changing consumed payment keys.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes split reimbursements after an incident review.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Returns the EIP-712 digest authorized by a split signer.
    function hashSplitIntent(SplitIntent calldata intent) public view returns (bytes32) {
        // SplitIntent contains only fixed-width fields, so this is canonical EIP-712 struct encoding.
        return _hashTypedDataV4(keccak256(abi.encode(SPLIT_INTENT_TYPEHASH, intent)));
    }

    // This intentionally centralizes the fail-closed signed reimbursement boundary.
    // Timestamp use is limited to the server-signed invitation validity boundary.
    // slither-disable-start timestamp
    // slither-disable-next-line cyclomatic-complexity
    function _validateIntent(SplitIntent calldata intent, bytes calldata signature)
        internal
        view
        returns (bytes32 intentDigest)
    {
        if (intent.paymentKey == bytes32(0)) revert InvalidPaymentKey();
        if (intent.splitDigest == bytes32(0)) revert InvalidSplitDigest();
        if (intent.originalOrderKey == bytes32(0)) revert InvalidOrderKey();
        if (intent.metadataHash == bytes32(0)) revert InvalidMetadataHash();
        if (paymentKeyUsed[intent.paymentKey]) revert PaymentKeyConsumed(intent.paymentKey);
        if (intent.payer != msg.sender) revert IntentPayerMismatch(intent.payer, msg.sender);
        if (intent.beneficiary == address(0) || intent.beneficiary == address(this)) revert ZeroAddress();
        if (intent.token != address(USDC)) revert InvalidToken(intent.token);
        if (intent.amount == 0) revert InvalidAmount();
        if (intent.validUntil < intent.validAfter) revert InvalidWindow();
        // These are short-lived signed invitation bounds; timestamp use is the intended policy.
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < intent.validAfter) revert IntentNotYetValid(intent.validAfter);
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > intent.validUntil) revert IntentExpired(intent.validUntil);
        uint64 validity = intent.validUntil - intent.validAfter;
        if (validity > MAX_INTENT_VALIDITY) revert IntentValidityTooLong(validity);

        intentDigest = hashSplitIntent(intent);
        (address signer, ECDSA.RecoverError recoverError, bytes32 recoverArgument) =
            ECDSA.tryRecover(intentDigest, signature);
        if (
            recoverError != ECDSA.RecoverError.NoError || recoverArgument != bytes32(0)
                || !hasRole(SPLIT_SIGNER_ROLE, signer)
        ) {
            revert InvalidSplitSignature();
        }
    }
    // slither-disable-end timestamp
}
