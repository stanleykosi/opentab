import { createHash } from 'node:crypto';
import type { RawContractLog } from '@opentab/application';
import { decodeEventLog, parseAbi } from 'viem';
import type { ContractLogDecoder, DecodeResult } from './types.js';

export const OPEN_TAB_EVENT_DECODER_VERSION = 'opentab-contract-events-v5' as const;

// This versioned list is compatibility-tested against Foundry artifacts. It is
// deliberately local to the worker so an ABI drift fails closed at decoding.
export const OPEN_TAB_EVENT_ABI = parseAbi([
  'event MerchantCreated(uint256 indexed merchantId,address indexed owner,address indexed payout,bytes32 metadataHash)',
  'event MerchantPayoutUpdated(uint256 indexed merchantId,address indexed previousPayout,address indexed newPayout)',
  'event MerchantStatusChanged(uint256 indexed merchantId,bool active)',
  'event MerchantSuspensionChanged(uint256 indexed merchantId,bool suspended,address indexed actor)',
  'event MerchantMetadataUpdated(uint256 indexed merchantId,bytes32 previousMetadataHash,bytes32 newMetadataHash)',
  'event ProductCreated(uint256 indexed productId,uint256 indexed merchantId,uint64 indexed version,uint128 unitPrice,uint64 startsAt,uint64 endsAt,uint64 maxSupply,uint64 maxPerWallet,uint32 loyaltyPoints,uint32 refundWindow,bytes32 metadataHash)',
  'event ProductUpdated(uint256 indexed productId,uint256 indexed merchantId,uint64 indexed version,uint128 unitPrice,uint64 startsAt,uint64 endsAt,uint64 maxSupply,uint64 maxPerWallet,uint32 loyaltyPoints,uint32 refundWindow,bytes32 metadataHash)',
  'event ProductStatusChanged(uint256 indexed productId,bool active)',
  'event OrderPaid(bytes32 indexed orderKey,uint256 indexed merchantId,uint256 indexed productId,address payer,address recipient,address token,uint64 quantity,uint256 amount,uint256 platformFee,uint256 passTokenId,uint64 refundDeadline,bytes32 intentDigest)',
  'event OrderRefunded(bytes32 indexed orderKey,uint256 indexed merchantId,address indexed payer,uint256 amount,uint256 platformFeeRefunded,uint256 cumulativeRefunded)',
  'event OrderFinalized(bytes32 indexed orderKey,uint256 indexed merchantId,uint256 merchantCredit,uint256 platformCredit)',
  'event MerchantWithdrawal(uint256 indexed merchantId,address indexed payout,uint256 amount,uint256 cumulativeWithdrawn)',
  'event LoyaltyAwarded(uint256 indexed merchantId,address indexed account,bytes32 indexed orderKey,uint256 points)',
  'event LoyaltyAdjusted(uint256 indexed merchantId,address indexed account,bytes32 indexed orderKey,uint256 pointsRemoved,uint256 remainingOrderPoints)',
  'event ProductPassConfigured(uint256 indexed productId,uint256 indexed tokenId,string metadataUri)',
  'event PassRevoked(bytes32 indexed orderKey,address indexed account,uint256 indexed tokenId,uint256 quantity)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
  'event SplitReimbursed(bytes32 indexed paymentKey,bytes32 indexed splitDigest,bytes32 indexed originalOrderKey,address payer,address beneficiary,address token,uint256 amount,bytes32 intentDigest)',
  'event SplitPaymentRevoked(bytes32 indexed paymentKey,bytes32 indexed splitDigest,address indexed actor)',
  'event FeeRecipientUpdated(address indexed previousRecipient,address indexed newRecipient)',
  'event PlatformFeeUpdated(uint16 previousFeeBps,uint16 newFeeBps)',
  'event PlatformWithdrawal(address indexed recipient,uint256 amount,uint256 cumulativeWithdrawn)',
  'event CheckoutBound(address indexed previousCheckout,address indexed newCheckout)',
  'event ApprovalForAll(address indexed account,address indexed operator,bool approved)',
  'event URI(string value,uint256 indexed id)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  'event RoleAdminChanged(bytes32 indexed role,bytes32 indexed previousAdminRole,bytes32 indexed newAdminRole)',
  'event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
  'event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)',
  'event DefaultAdminDelayChangeCanceled()',
  'event DefaultAdminDelayChangeScheduled(uint48 newDelay,uint48 effectSchedule)',
  'event DefaultAdminTransferCanceled()',
  'event DefaultAdminTransferScheduled(address indexed newAdmin,uint48 acceptSchedule)',
  'event EIP712DomainChanged()',
]);

function unknownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function normalizeField(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  // viem intentionally decodes ABI integers up to 48 bits as JavaScript
  // numbers. All such fields in the allowlisted OpenTab events are unsigned,
  // so accept only exact non-negative integers and normalize them at the
  // boundary just like wider bigint values.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

export function digestRawLog(log: RawContractLog): `0x${string}` {
  const digest = createHash('sha256');
  digest.update(log.chainId);
  digest.update('\0');
  digest.update(log.contractAddress.toLowerCase());
  digest.update('\0');
  digest.update(log.transactionHash.toLowerCase());
  digest.update('\0');
  digest.update(log.blockHash.toLowerCase());
  digest.update('\0');
  digest.update(log.logIndex);
  for (const topic of log.topics) digest.update(topic.toLowerCase());
  digest.update(log.data.toLowerCase());
  return `0x${digest.digest('hex')}`;
}

export class OpenTabContractLogDecoder implements ContractLogDecoder {
  readonly version = OPEN_TAB_EVENT_DECODER_VERSION;

  decode(log: RawContractLog): DecodeResult {
    try {
      const decoded = decodeEventLog({
        abi: OPEN_TAB_EVENT_ABI,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
        strict: true,
      });
      const args = unknownRecord(decoded.args);
      if (args === undefined) {
        return {
          kind: 'quarantined',
          reasonCode: 'EVENT_ARGS_INVALID',
          safeDetails: { eventName: decoded.eventName },
          decoderVersion: this.version,
        };
      }
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(args)) {
        const normalized = normalizeField(value);
        if (normalized === undefined) {
          return {
            kind: 'quarantined',
            reasonCode: 'EVENT_FIELD_INVALID',
            safeDetails: { eventName: decoded.eventName, field: key },
            decoderVersion: this.version,
          };
        }
        fields[key] = normalized;
      }
      return {
        kind: 'decoded',
        event: { eventName: decoded.eventName, fields, decoderVersion: this.version },
      };
    } catch {
      return {
        kind: 'quarantined',
        reasonCode: 'EVENT_ABI_UNKNOWN',
        safeDetails: {
          topic0: log.topics[0] ?? 'missing',
          contract: log.contractAddress.toLowerCase(),
        },
        decoderVersion: this.version,
      };
    }
  }
}
