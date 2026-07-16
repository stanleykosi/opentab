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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IOpenTabPass} from "./interfaces/IOpenTabPass.sol";

/// @title OpenTabCheckout
/// @notice Native Arbitrum USDC settlement, refundable escrow, merchant credit, and receipt issuance.
/// @dev Non-upgradeable. Server-signed EIP-712 intents constrain every payment parameter; canonical
///      events are the source of financial truth for off-chain projections.
contract OpenTabCheckout is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    string public constant CONTRACT_VERSION = "1.0.0";
    uint16 public constant MAX_PLATFORM_FEE_BPS = 500;
    uint64 public constant MAX_QUANTITY_PER_ORDER = 1_000;
    uint64 public constant MAX_INTENT_VALIDITY = 1 hours;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant MERCHANT_MANAGER_ROLE = keccak256("MERCHANT_MANAGER_ROLE");
    bytes32 public constant ORDER_SIGNER_ROLE = keccak256("ORDER_SIGNER_ROLE");
    bytes32 public constant REFUND_OPERATOR_ROLE = keccak256("REFUND_OPERATOR_ROLE");

    bytes32 public constant ORDER_INTENT_TYPEHASH = keccak256(
        "OrderIntent(bytes32 orderKey,address payer,address recipient,uint256 merchantId,uint256 productId,uint64 productVersion,address token,uint256 amount,uint16 platformFeeBps,uint256 platformFee,uint64 quantity,uint64 validAfter,uint64 validUntil,uint64 refundDeadline,bytes32 metadataHash)"
    );

    struct Merchant {
        address owner;
        address payout;
        bytes32 metadataHash;
        uint64 createdAt;
        bool active;
        bool suspended;
    }

    struct Product {
        uint256 merchantId;
        uint128 unitPrice;
        uint64 startsAt;
        uint64 endsAt;
        uint64 maxSupply;
        uint64 sold;
        uint64 maxPerWallet;
        uint64 version;
        uint32 loyaltyPoints;
        uint32 refundWindow;
        bool active;
        bytes32 metadataHash;
    }

    struct ProductInput {
        uint256 merchantId;
        uint128 unitPrice;
        uint64 startsAt;
        uint64 endsAt;
        uint64 maxSupply;
        uint64 maxPerWallet;
        uint32 loyaltyPoints;
        uint32 refundWindow;
        bytes32 metadataHash;
        string passUri;
    }

    struct ProductUpdate {
        uint128 unitPrice;
        uint64 startsAt;
        uint64 endsAt;
        uint64 maxSupply;
        uint64 maxPerWallet;
        uint32 loyaltyPoints;
        uint32 refundWindow;
        bytes32 metadataHash;
        string passUri;
    }

    struct OrderIntent {
        bytes32 orderKey;
        address payer;
        address recipient;
        uint256 merchantId;
        uint256 productId;
        uint64 productVersion;
        address token;
        uint256 amount;
        uint16 platformFeeBps;
        uint256 platformFee;
        uint64 quantity;
        uint64 validAfter;
        uint64 validUntil;
        uint64 refundDeadline;
        bytes32 metadataHash;
    }

    struct Order {
        uint256 merchantId;
        uint256 productId;
        address payer;
        address recipient;
        uint128 grossAmount;
        uint128 platformFee;
        uint128 refundedAmount;
        uint128 merchantRefunded;
        uint128 platformRefunded;
        uint128 loyaltyAwarded;
        uint128 loyaltyRefunded;
        uint64 quantity;
        uint64 paidAt;
        uint64 refundDeadline;
        uint16 platformFeeBps;
        bool finalized;
    }

    error ZeroAddress();
    error InvalidContract(address account);
    error InvalidTokenDecimals(uint8 actual);
    error InvalidAmount();
    error InvalidQuantity();
    error InvalidWindow();
    error InvalidMetadataHash();
    error InvalidPayout(address payout);
    error MerchantPayoutChanged(address expectedPayout, address currentPayout);
    error InvalidToken(address token);
    error MerchantNotFound(uint256 merchantId);
    error MerchantInactive(uint256 merchantId);
    error MerchantSuspended(uint256 merchantId);
    error UnauthorizedMerchant(uint256 merchantId, address caller);
    error ProductNotFound(uint256 productId);
    error ProductInactive(uint256 productId);
    error ProductHasSales(uint256 productId);
    error ProductVersionMismatch(uint64 expected, uint64 actual);
    error ProductMerchantMismatch(uint256 expected, uint256 actual);
    error ProductMetadataMismatch(bytes32 expected, bytes32 actual);
    error SaleNotStarted(uint64 startsAt);
    error SaleEnded(uint64 endsAt);
    error SoldOut(uint256 productId);
    error PurchaseLimitExceeded(uint64 requestedTotal, uint64 maximum);
    error OrderKeyZero();
    error OrderAlreadyExists(bytes32 orderKey);
    error OrderNotFound(bytes32 orderKey);
    error OrderAlreadyFinalized(bytes32 orderKey);
    error OrderNotFinalizable(uint64 refundDeadline);
    error OrderNotRefundable(bytes32 orderKey);
    error RefundWindowClosed(uint64 refundDeadline);
    error RefundExceedsPaid(uint256 requested, uint256 remaining);
    error UnauthorizedRefund(bytes32 orderKey, address caller);
    error InsufficientMerchantBalance(uint256 requested, uint256 available);
    error InsufficientPlatformBalance(uint256 requested, uint256 available);
    error UnauthorizedFeeRecipient(address caller);
    error FeeTooHigh(uint256 requestedBps, uint256 maxBps);
    error FeeMismatch(uint256 expected, uint256 actual);
    error AmountMismatch(uint256 expected, uint256 actual);
    error IntentPayerMismatch(address expected, address actual);
    error IntentNotYetValid(uint64 validAfter);
    error IntentExpired(uint64 validUntil);
    error IntentValidityTooLong(uint64 validity);
    error RefundTermsMismatch(uint64 expected, uint64 actual);
    error InvalidOrderSignature();
    error UnsupportedTokenBehavior(uint256 expected, uint256 actual);

    event MerchantCreated(
        uint256 indexed merchantId, address indexed owner, address indexed payout, bytes32 metadataHash
    );
    event MerchantPayoutUpdated(uint256 indexed merchantId, address indexed previousPayout, address indexed newPayout);
    event MerchantStatusChanged(uint256 indexed merchantId, bool active);
    event MerchantSuspensionChanged(uint256 indexed merchantId, bool suspended, address indexed operator);
    event MerchantMetadataUpdated(uint256 indexed merchantId, bytes32 previousHash, bytes32 newHash);

    event ProductCreated(
        uint256 indexed productId,
        uint256 indexed merchantId,
        uint64 indexed version,
        uint128 unitPrice,
        uint64 startsAt,
        uint64 endsAt,
        uint64 maxSupply,
        uint64 maxPerWallet,
        uint32 loyaltyPoints,
        uint32 refundWindow,
        bytes32 metadataHash
    );
    event ProductUpdated(
        uint256 indexed productId,
        uint256 indexed merchantId,
        uint64 indexed version,
        uint128 unitPrice,
        uint64 startsAt,
        uint64 endsAt,
        uint64 maxSupply,
        uint64 maxPerWallet,
        uint32 loyaltyPoints,
        uint32 refundWindow,
        bytes32 metadataHash
    );
    event ProductStatusChanged(uint256 indexed productId, bool active);

    event OrderPaid(
        bytes32 indexed orderKey,
        uint256 indexed merchantId,
        uint256 indexed productId,
        address payer,
        address recipient,
        address token,
        uint64 quantity,
        uint256 amount,
        uint256 platformFee,
        uint256 passTokenId,
        uint64 refundDeadline,
        bytes32 intentDigest
    );
    event OrderRefunded(
        bytes32 indexed orderKey,
        uint256 indexed merchantId,
        address indexed payer,
        uint256 amount,
        uint256 platformFeeRefunded,
        uint256 cumulativeRefunded
    );
    event OrderFinalized(
        bytes32 indexed orderKey, uint256 indexed merchantId, uint256 merchantCredit, uint256 platformCredit
    );
    event MerchantWithdrawal(
        uint256 indexed merchantId, address indexed payout, uint256 amount, uint256 cumulativeWithdrawn
    );
    event PlatformWithdrawal(address indexed recipient, uint256 amount, uint256 cumulativeWithdrawn);
    event LoyaltyAwarded(uint256 indexed merchantId, address indexed account, bytes32 indexed orderKey, uint256 points);
    event LoyaltyAdjusted(
        uint256 indexed merchantId,
        address indexed account,
        bytes32 indexed orderKey,
        uint256 pointsRemoved,
        uint256 remainingOrderPoints
    );
    event PlatformFeeUpdated(uint16 previousBps, uint16 newBps);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    // Uppercase immutable names are intentional: both addresses are deployment-time constants.
    // slither-disable-next-line naming-convention
    IERC20Metadata public immutable USDC;
    // slither-disable-next-line naming-convention
    IOpenTabPass public immutable PASS;

    address public feeRecipient;
    uint16 public platformFeeBps;
    uint256 public nextMerchantId = 1;
    uint256 public nextProductId = 1;

    mapping(uint256 merchantId => Merchant merchant) public merchants;
    mapping(uint256 productId => Product product) public products;
    // The explicit getOrder view returns the typed struct. A public mapping here
    // would generate a fragile 16-value flattened getter and cannot be instrumented
    // by Foundry's minimum-via-IR coverage profile.
    mapping(bytes32 orderKey => Order order) internal orders;
    mapping(uint256 productId => mapping(address account => uint64 quantity)) public purchasedByWallet;
    mapping(uint256 merchantId => mapping(address account => uint256 points)) public loyaltyPoints;

    mapping(uint256 merchantId => uint256 amount) public merchantLocked;
    mapping(uint256 merchantId => uint256 amount) public merchantCredit;
    mapping(uint256 merchantId => uint256 amount) public merchantWithdrawn;
    uint256 public platformLocked;
    uint256 public platformCredit;
    uint256 public platformWithdrawn;
    uint256 public totalLockedLiability;
    uint256 public totalMerchantCredit;

    constructor(
        IERC20Metadata usdc,
        IOpenTabPass pass,
        address admin,
        uint48 adminDelay,
        address pauser,
        address feeManager,
        address merchantManager,
        address orderSigner,
        address feeRecipient_,
        uint16 initialPlatformFeeBps
    ) AccessControlDefaultAdminRules(adminDelay, admin) EIP712("OpenTab Order Intent", "1") {
        if (
            address(usdc) == address(0) || address(pass) == address(0) || pauser == address(0)
                || feeManager == address(0) || merchantManager == address(0) || orderSigner == address(0)
                || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (address(usdc).code.length == 0) revert InvalidContract(address(usdc));
        if (address(pass).code.length == 0) revert InvalidContract(address(pass));
        uint8 decimals = usdc.decimals();
        if (decimals != 6) revert InvalidTokenDecimals(decimals);
        if (initialPlatformFeeBps > MAX_PLATFORM_FEE_BPS) {
            revert FeeTooHigh(initialPlatformFeeBps, MAX_PLATFORM_FEE_BPS);
        }

        USDC = usdc;
        PASS = pass;
        feeRecipient = feeRecipient_;
        platformFeeBps = initialPlatformFeeBps;

        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(FEE_MANAGER_ROLE, feeManager);
        _grantRole(MERCHANT_MANAGER_ROLE, merchantManager);
        _grantRole(ORDER_SIGNER_ROLE, orderSigner);
    }

    /// @notice Creates a permissionless merchant profile owned by the caller.
    function createMerchant(address payout, bytes32 metadataHash) external whenNotPaused returns (uint256 merchantId) {
        _validatePayout(payout);
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
        merchantId = nextMerchantId++;
        merchants[merchantId] = Merchant({
            owner: msg.sender,
            payout: payout,
            metadataHash: metadataHash,
            createdAt: uint256(block.timestamp).toUint64(),
            active: true,
            suspended: false
        });
        emit MerchantCreated(merchantId, msg.sender, payout, metadataHash);
    }

    /// @notice Changes a merchant's settlement payout address.
    function updateMerchantPayout(uint256 merchantId, address payout) external whenNotPaused {
        Merchant storage merchant = _requireMerchantOwner(merchantId);
        _validatePayout(payout);
        address previous = merchant.payout;
        merchant.payout = payout;
        emit MerchantPayoutUpdated(merchantId, previous, payout);
    }

    /// @notice Changes the canonical metadata digest for a merchant.
    function updateMerchantMetadata(uint256 merchantId, bytes32 metadataHash) external whenNotPaused {
        Merchant storage merchant = _requireMerchantOwner(merchantId);
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
        bytes32 previous = merchant.metadataHash;
        merchant.metadataHash = metadataHash;
        emit MerchantMetadataUpdated(merchantId, previous, metadataHash);
    }

    /// @notice Lets a merchant activate or pause its own profile.
    function setMerchantActive(uint256 merchantId, bool active) external whenNotPaused {
        Merchant storage merchant = _requireMerchantOwner(merchantId);
        merchant.active = active;
        emit MerchantStatusChanged(merchantId, active);
    }

    /// @notice Compliance/emergency suspension independent from merchant-controlled active status.
    function setMerchantSuspended(uint256 merchantId, bool suspended) external onlyRole(MERCHANT_MANAGER_ROLE) {
        Merchant storage merchant = merchants[merchantId];
        if (merchant.owner == address(0)) revert MerchantNotFound(merchantId);
        merchant.suspended = suspended;
        emit MerchantSuspensionChanged(merchantId, suspended, msg.sender);
    }

    /// @notice Creates an inactive product and configures its non-transferable pass metadata.
    function createProduct(ProductInput calldata input)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 productId)
    {
        Merchant storage merchant = _requireMerchantOwner(input.merchantId);
        _requireMerchantUsable(input.merchantId, merchant);
        _validateProductInput(input.unitPrice, input.startsAt, input.endsAt, input.metadataHash);

        productId = nextProductId++;
        products[productId] = Product({
            merchantId: input.merchantId,
            unitPrice: input.unitPrice,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            maxSupply: input.maxSupply,
            sold: 0,
            maxPerWallet: input.maxPerWallet,
            version: 1,
            loyaltyPoints: input.loyaltyPoints,
            refundWindow: input.refundWindow,
            active: false,
            metadataHash: input.metadataHash
        });
        PASS.configureProduct(productId, input.passUri);
        _emitProductCreated(productId, products[productId]);
    }

    /// @notice Updates an unsold product and increments its signed-intent version.
    /// @dev Once sales exist, create a new product version/ID so old purchases remain unambiguous.
    function updateProduct(uint256 productId, ProductUpdate calldata update) external whenNotPaused nonReentrant {
        Product storage product = products[productId];
        if (product.merchantId == 0) revert ProductNotFound(productId);
        _requireMerchantOwner(product.merchantId);
        if (product.sold != 0) revert ProductHasSales(productId);
        _validateProductInput(update.unitPrice, update.startsAt, update.endsAt, update.metadataHash);

        product.unitPrice = update.unitPrice;
        product.startsAt = update.startsAt;
        product.endsAt = update.endsAt;
        product.maxSupply = update.maxSupply;
        product.maxPerWallet = update.maxPerWallet;
        product.loyaltyPoints = update.loyaltyPoints;
        product.refundWindow = update.refundWindow;
        product.metadataHash = update.metadataHash;
        product.version += 1;
        PASS.configureProduct(productId, update.passUri);
        _emitProductUpdated(productId, product);
    }

    /// @notice Activates or pauses an owned product without changing its signed configuration.
    function setProductActive(uint256 productId, bool active) external whenNotPaused {
        Product storage product = products[productId];
        if (product.merchantId == 0) revert ProductNotFound(productId);
        Merchant storage merchant = _requireMerchantOwner(product.merchantId);
        if (active) _requireMerchantUsable(product.merchantId, merchant);
        product.active = active;
        emit ProductStatusChanged(productId, active);
    }

    /// @notice Pays an exact server-authorized order and atomically mints its pass.
    function pay(OrderIntent calldata intent, bytes calldata signature) external whenNotPaused nonReentrant {
        (Product storage product, bytes32 intentDigest) = _validateOrderIntent(intent, signature);

        uint64 newSold = product.sold + intent.quantity;
        if (product.maxSupply != 0 && newSold > product.maxSupply) revert SoldOut(intent.productId);
        uint64 newWalletTotal = purchasedByWallet[intent.productId][intent.recipient] + intent.quantity;
        if (product.maxPerWallet != 0 && newWalletTotal > product.maxPerWallet) {
            revert PurchaseLimitExceeded(newWalletTotal, product.maxPerWallet);
        }

        uint256 merchantAmount = intent.amount - intent.platformFee;
        uint256 awarded = uint256(product.loyaltyPoints) * intent.quantity;
        product.sold = newSold;
        purchasedByWallet[intent.productId][intent.recipient] = newWalletTotal;
        orders[intent.orderKey] = Order({
            merchantId: intent.merchantId,
            productId: intent.productId,
            payer: intent.payer,
            recipient: intent.recipient,
            grossAmount: intent.amount.toUint128(),
            platformFee: intent.platformFee.toUint128(),
            refundedAmount: 0,
            merchantRefunded: 0,
            platformRefunded: 0,
            loyaltyAwarded: awarded.toUint128(),
            loyaltyRefunded: 0,
            quantity: intent.quantity,
            paidAt: uint256(block.timestamp).toUint64(),
            refundDeadline: intent.refundDeadline,
            platformFeeBps: intent.platformFeeBps,
            finalized: false
        });
        merchantLocked[intent.merchantId] += merchantAmount;
        platformLocked += intent.platformFee;
        totalLockedLiability += intent.amount;

        if (awarded != 0) {
            loyaltyPoints[intent.merchantId][intent.recipient] += awarded;
            emit LoyaltyAwarded(intent.merchantId, intent.recipient, intent.orderKey, awarded);
        }

        uint256 balanceBefore = USDC.balanceOf(address(this));
        IERC20(address(USDC)).safeTransferFrom(msg.sender, address(this), intent.amount);
        uint256 received = USDC.balanceOf(address(this)) - balanceBefore;
        if (received != intent.amount) revert UnsupportedTokenBehavior(intent.amount, received);

        PASS.mint(intent.recipient, intent.productId, intent.quantity, "");
        _emitOrderPaid(intent, intentDigest);

        // A standard native USDC payment must leave every recorded liability fully covered.
        assert(USDC.balanceOf(address(this)) >= totalLiability());
    }

    /// @notice Refunds an arbitrary exact portion of an order while its funds remain locked.
    /// @dev Cumulative fee refunds use floor(fee * cumulativeRefund / gross), eliminating split-round drift.
    // Timestamp use in this function is limited to the signed refund-policy boundary.
    // slither-disable-start timestamp
    function refund(bytes32 orderKey, uint256 amount) external whenNotPaused nonReentrant {
        Order storage order = orders[orderKey];
        if (order.payer == address(0)) revert OrderNotFound(orderKey);
        if (order.finalized) revert OrderAlreadyFinalized(orderKey);
        if (order.refundDeadline == 0) revert OrderNotRefundable(orderKey);
        // Timestamp is the explicit signed refund-policy boundary; small sequencer drift is acceptable.
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > order.refundDeadline) revert RefundWindowClosed(order.refundDeadline);
        Merchant storage merchant = merchants[order.merchantId];
        if (msg.sender != merchant.owner && !hasRole(REFUND_OPERATOR_ROLE, msg.sender)) {
            revert UnauthorizedRefund(orderKey, msg.sender);
        }
        if (amount == 0) revert InvalidAmount();

        uint256 gross = order.grossAmount;
        uint256 currentRefunded = order.refundedAmount;
        uint256 remaining = gross - currentRefunded;
        if (amount > remaining) revert RefundExceedsPaid(amount, remaining);

        uint256 newCumulative = currentRefunded + amount;
        uint256 cumulativePlatformRefund = Math.mulDiv(order.platformFee, newCumulative, gross);
        uint256 platformDelta = cumulativePlatformRefund - order.platformRefunded;
        uint256 merchantDelta = amount - platformDelta;
        uint256 cumulativeLoyaltyRefund = Math.mulDiv(order.loyaltyAwarded, newCumulative, gross);
        uint256 loyaltyDelta = cumulativeLoyaltyRefund - order.loyaltyRefunded;

        order.refundedAmount = newCumulative.toUint128();
        order.platformRefunded = cumulativePlatformRefund.toUint128();
        order.merchantRefunded = (uint256(order.merchantRefunded) + merchantDelta).toUint128();
        order.loyaltyRefunded = cumulativeLoyaltyRefund.toUint128();
        merchantLocked[order.merchantId] -= merchantDelta;
        platformLocked -= platformDelta;
        totalLockedLiability -= amount;
        if (loyaltyDelta != 0) {
            loyaltyPoints[order.merchantId][order.recipient] -= loyaltyDelta;
            emit LoyaltyAdjusted(
                order.merchantId,
                order.recipient,
                orderKey,
                loyaltyDelta,
                uint256(order.loyaltyAwarded) - cumulativeLoyaltyRefund
            );
        }

        _transferOutExact(order.payer, amount);
        if (newCumulative == gross) {
            PASS.burn(order.recipient, order.productId, order.quantity, orderKey);
        }

        emit OrderRefunded(orderKey, order.merchantId, order.payer, amount, platformDelta, newCumulative);
        assert(USDC.balanceOf(address(this)) >= totalLiability());
    }

    // slither-disable-end timestamp

    /// @notice Permissionlessly matures one order after its refund window.
    // Timestamp use in this function is limited to the signed maturation boundary.
    // slither-disable-start timestamp
    function finalizeOrder(bytes32 orderKey) external whenNotPaused {
        Order storage order = orders[orderKey];
        if (order.payer == address(0)) revert OrderNotFound(orderKey);
        if (order.finalized) revert OrderAlreadyFinalized(orderKey);
        // Permissionless maturation intentionally uses the order's signed policy timestamp.
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (order.refundDeadline != 0 && block.timestamp <= order.refundDeadline) {
            revert OrderNotFinalizable(order.refundDeadline);
        }

        uint256 merchantAmount = uint256(order.grossAmount) - order.platformFee - order.merchantRefunded;
        uint256 platformAmount = uint256(order.platformFee) - order.platformRefunded;
        uint256 remaining = merchantAmount + platformAmount;

        order.finalized = true;
        merchantLocked[order.merchantId] -= merchantAmount;
        platformLocked -= platformAmount;
        totalLockedLiability -= remaining;
        merchantCredit[order.merchantId] += merchantAmount;
        totalMerchantCredit += merchantAmount;
        platformCredit += platformAmount;

        emit OrderFinalized(orderKey, order.merchantId, merchantAmount, platformAmount);
        assert(USDC.balanceOf(address(this)) >= totalLiability());
    }

    // slither-disable-end timestamp

    /// @notice Withdraws matured credit only when the caller-bound payout remains current.
    /// @param expectedPayout Payout address displayed and approved before submission.
    function withdrawMerchant(uint256 merchantId, uint256 amount, address expectedPayout)
        external
        whenNotPaused
        nonReentrant
    {
        Merchant storage merchant = _requireMerchantOwner(merchantId);
        if (merchant.payout != expectedPayout) {
            revert MerchantPayoutChanged(expectedPayout, merchant.payout);
        }
        if (amount == 0) revert InvalidAmount();
        uint256 available = merchantCredit[merchantId];
        if (amount > available) revert InsufficientMerchantBalance(amount, available);

        merchantCredit[merchantId] = available - amount;
        totalMerchantCredit -= amount;
        merchantWithdrawn[merchantId] += amount;
        _transferOutExact(merchant.payout, amount);
        emit MerchantWithdrawal(merchantId, merchant.payout, amount, merchantWithdrawn[merchantId]);
        assert(USDC.balanceOf(address(this)) >= totalLiability());
    }

    /// @notice Withdraws matured platform credit only to the stored fee recipient.
    function withdrawPlatform(uint256 amount) external whenNotPaused nonReentrant {
        if (msg.sender != feeRecipient) revert UnauthorizedFeeRecipient(msg.sender);
        if (amount == 0) revert InvalidAmount();
        uint256 available = platformCredit;
        if (amount > available) revert InsufficientPlatformBalance(amount, available);

        platformCredit = available - amount;
        platformWithdrawn += amount;
        _transferOutExact(feeRecipient, amount);
        emit PlatformWithdrawal(feeRecipient, amount, platformWithdrawn);
        assert(USDC.balanceOf(address(this)) >= totalLiability());
    }

    /// @notice Sets the quoted platform fee while enforcing the permanent fee cap.
    function setPlatformFeeBps(uint16 newBps) external onlyRole(FEE_MANAGER_ROLE) {
        if (newBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh(newBps, MAX_PLATFORM_FEE_BPS);
        uint16 previous = platformFeeBps;
        platformFeeBps = newBps;
        emit PlatformFeeUpdated(previous, newBps);
    }

    /// @notice Changes only where matured platform fees are paid; never affects merchant liabilities.
    function setFeeRecipient(address newRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRecipient == address(0) || newRecipient == address(this)) revert ZeroAddress();
        address previous = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(previous, newRecipient);
    }

    /// @notice Pauses merchant mutations and token-moving checkout operations.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes checkout operations after an incident review.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Total currently recorded token liability; useful for independent monitoring.
    function totalLiability() public view returns (uint256) {
        return totalLockedLiability + totalMerchantCredit + platformCredit;
    }

    /// @notice Reports whether an order key has already been consumed.
    function orderExists(bytes32 orderKey) external view returns (bool) {
        // Slither traces the packed Order timestamp field into this unrelated existence check.
        // slither-disable-next-line timestamp
        return orders[orderKey].payer != address(0);
    }

    /// @notice Returns the complete merchant record for an onchain identifier.
    function getMerchant(uint256 merchantId) external view returns (Merchant memory) {
        return merchants[merchantId];
    }

    /// @notice Returns the complete product record for an onchain identifier.
    function getProduct(uint256 productId) external view returns (Product memory) {
        return products[productId];
    }

    /// @notice Returns the authoritative financial record for an order key.
    function getOrder(bytes32 orderKey) external view returns (Order memory) {
        return orders[orderKey];
    }

    /// @notice Quotes exact product gross amount and the current configured platform fee.
    function quote(uint256 productId, uint64 quantity) external view returns (uint256 grossAmount, uint256 feeAmount) {
        Product storage product = products[productId];
        if (product.merchantId == 0) revert ProductNotFound(productId);
        if (quantity == 0 || quantity > MAX_QUANTITY_PER_ORDER) revert InvalidQuantity();
        grossAmount = uint256(product.unitPrice) * quantity;
        feeAmount = Math.mulDiv(grossAmount, platformFeeBps, 10_000);
    }

    /// @notice EIP-712 digest that the configured order signer authorizes.
    function hashOrderIntent(OrderIntent calldata intent) public view returns (bytes32) {
        // OrderIntent contains only fixed-width fields, so encoding the tuple after its type hash
        // is byte-for-byte the canonical EIP-712 struct encoding.
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_INTENT_TYPEHASH, intent)));
    }

    // This intentionally centralizes the fail-closed signed quote boundary.
    // slither-disable-next-line cyclomatic-complexity
    function _validateOrderIntent(OrderIntent calldata intent, bytes calldata signature)
        internal
        view
        returns (Product storage product, bytes32 intentDigest)
    {
        if (intent.orderKey == bytes32(0)) revert OrderKeyZero();
        // Slither traces the packed Order timestamp field into this unrelated replay check.
        // slither-disable-next-line timestamp
        if (orders[intent.orderKey].payer != address(0)) revert OrderAlreadyExists(intent.orderKey);
        if (intent.payer != msg.sender) revert IntentPayerMismatch(intent.payer, msg.sender);
        if (intent.recipient == address(0)) revert ZeroAddress();
        if (intent.token != address(USDC)) revert InvalidToken(intent.token);
        if (intent.quantity == 0 || intent.quantity > MAX_QUANTITY_PER_ORDER) revert InvalidQuantity();
        if (intent.validUntil < intent.validAfter) revert InvalidWindow();
        // These are short-lived signed quote bounds; timestamp use is the intended authorization policy.
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < intent.validAfter) revert IntentNotYetValid(intent.validAfter);
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > intent.validUntil) revert IntentExpired(intent.validUntil);
        uint64 validity = intent.validUntil - intent.validAfter;
        if (validity > MAX_INTENT_VALIDITY) revert IntentValidityTooLong(validity);

        product = products[intent.productId];
        if (product.merchantId == 0) revert ProductNotFound(intent.productId);
        if (!product.active) revert ProductInactive(intent.productId);
        if (product.merchantId != intent.merchantId) {
            revert ProductMerchantMismatch(product.merchantId, intent.merchantId);
        }
        if (product.version != intent.productVersion) {
            revert ProductVersionMismatch(product.version, intent.productVersion);
        }
        if (product.metadataHash != intent.metadataHash) {
            revert ProductMetadataMismatch(product.metadataHash, intent.metadataHash);
        }
        Merchant storage merchant = merchants[intent.merchantId];
        _requireMerchantUsable(intent.merchantId, merchant);
        // Product sale windows are intentionally timestamp-based business constraints.
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < product.startsAt) revert SaleNotStarted(product.startsAt);
        // slither-disable-next-line timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (product.endsAt != 0 && block.timestamp > product.endsAt) revert SaleEnded(product.endsAt);

        uint256 expectedAmount = uint256(product.unitPrice) * intent.quantity;
        if (intent.amount != expectedAmount) revert AmountMismatch(expectedAmount, intent.amount);
        if (intent.amount == 0 || intent.amount > type(uint128).max) revert InvalidAmount();
        if (intent.platformFeeBps > MAX_PLATFORM_FEE_BPS) {
            revert FeeTooHigh(intent.platformFeeBps, MAX_PLATFORM_FEE_BPS);
        }
        uint256 expectedFee = Math.mulDiv(expectedAmount, intent.platformFeeBps, 10_000);
        if (intent.platformFee != expectedFee) revert FeeMismatch(expectedFee, intent.platformFee);
        uint64 expectedRefundDeadline =
            product.refundWindow == 0 ? 0 : (uint256(intent.validUntil) + product.refundWindow).toUint64();
        if (intent.refundDeadline != expectedRefundDeadline) {
            revert RefundTermsMismatch(expectedRefundDeadline, intent.refundDeadline);
        }

        intentDigest = hashOrderIntent(intent);
        (address signer, ECDSA.RecoverError recoverError, bytes32 recoverArgument) =
            ECDSA.tryRecover(intentDigest, signature);
        if (
            recoverError != ECDSA.RecoverError.NoError || recoverArgument != bytes32(0)
                || !hasRole(ORDER_SIGNER_ROLE, signer)
        ) {
            revert InvalidOrderSignature();
        }
    }

    function _requireMerchantOwner(uint256 merchantId) internal view returns (Merchant storage merchant) {
        merchant = merchants[merchantId];
        if (merchant.owner == address(0)) revert MerchantNotFound(merchantId);
        if (merchant.owner != msg.sender) revert UnauthorizedMerchant(merchantId, msg.sender);
    }

    function _requireMerchantUsable(uint256 merchantId, Merchant storage merchant) internal view {
        if (!merchant.active) revert MerchantInactive(merchantId);
        if (merchant.suspended) revert MerchantSuspended(merchantId);
    }

    function _validatePayout(address payout) internal view {
        if (payout == address(0) || payout == address(this)) revert InvalidPayout(payout);
    }

    function _validateProductInput(uint128 unitPrice, uint64 startsAt, uint64 endsAt, bytes32 metadataHash)
        internal
        pure
    {
        if (unitPrice == 0) revert InvalidAmount();
        if (endsAt != 0 && endsAt <= startsAt) revert InvalidWindow();
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
    }

    function _transferOutExact(address recipient, uint256 amount) internal {
        uint256 contractBefore = USDC.balanceOf(address(this));
        uint256 recipientBefore = USDC.balanceOf(recipient);
        IERC20(address(USDC)).safeTransfer(recipient, amount);
        uint256 contractDelta = contractBefore - USDC.balanceOf(address(this));
        uint256 recipientDelta = USDC.balanceOf(recipient) - recipientBefore;
        if (contractDelta != amount || recipientDelta != amount) {
            revert UnsupportedTokenBehavior(amount, recipientDelta);
        }
    }

    function _emitProductCreated(uint256 productId, Product storage product) internal {
        emit ProductCreated(
            productId,
            product.merchantId,
            product.version,
            product.unitPrice,
            product.startsAt,
            product.endsAt,
            product.maxSupply,
            product.maxPerWallet,
            product.loyaltyPoints,
            product.refundWindow,
            product.metadataHash
        );
    }

    function _emitProductUpdated(uint256 productId, Product storage product) internal {
        emit ProductUpdated(
            productId,
            product.merchantId,
            product.version,
            product.unitPrice,
            product.startsAt,
            product.endsAt,
            product.maxSupply,
            product.maxPerWallet,
            product.loyaltyPoints,
            product.refundWindow,
            product.metadataHash
        );
    }

    function _emitOrderPaid(OrderIntent calldata intent, bytes32 intentDigest) internal {
        emit OrderPaid(
            intent.orderKey,
            intent.merchantId,
            intent.productId,
            intent.payer,
            intent.recipient,
            intent.token,
            intent.quantity,
            intent.amount,
            intent.platformFee,
            intent.productId,
            intent.refundDeadline,
            intentDigest
        );
    }
}
