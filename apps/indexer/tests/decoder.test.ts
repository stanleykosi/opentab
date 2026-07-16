import { readFileSync } from 'node:fs';
import type { RawContractLog } from '@opentab/application';
import { ARBITRUM_ONE_CHAIN_ID, EvmAddressSchema, TransactionHashSchema } from '@opentab/shared';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { digestRawLog, OPEN_TAB_EVENT_ABI, OpenTabContractLogDecoder } from '../src/decoder.js';

const contract = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const payer = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const recipient = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const token = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const txHash = TransactionHashSchema.parse(`0x${'5'.repeat(64)}`);
const orderKey = `0x${'6'.repeat(64)}` as const;
const intentDigest = `0x${'7'.repeat(64)}` as const;

function baseLog(): RawContractLog {
  return {
    chainId: ARBITRUM_ONE_CHAIN_ID,
    contractAddress: contract,
    transactionHash: txHash,
    blockNumber: '100',
    blockHash: `0x${'8'.repeat(64)}`,
    logIndex: '3',
    topics: [`0x${'9'.repeat(64)}`],
    data: '0x',
  };
}

describe('versioned contract event decoder', () => {
  it('decodes every OrderPaid field into canonical decimal/address strings', () => {
    const topics = encodeEventTopics({
      abi: OPEN_TAB_EVENT_ABI,
      eventName: 'OrderPaid',
      args: { orderKey, merchantId: 9n, productId: 7n },
    });
    const data = encodeAbiParameters(
      parseAbiParameters(
        'address payer,address recipient,address token,uint64 quantity,uint256 amount,uint256 platformFee,uint256 passTokenId,uint64 refundDeadline,bytes32 intentDigest',
      ),
      [
        payer as `0x${string}`,
        recipient as `0x${string}`,
        token as `0x${string}`,
        2n,
        2_000_000n,
        50_000n,
        7n,
        1_800_000_000n,
        intentDigest,
      ],
    );
    const result = new OpenTabContractLogDecoder().decode({
      ...baseLog(),
      topics: topics as readonly `0x${string}`[],
      data,
    });

    expect(result).toEqual({
      kind: 'decoded',
      event: {
        eventName: 'OrderPaid',
        decoderVersion: 'opentab-contract-events-v4',
        fields: {
          orderKey,
          merchantId: '9',
          productId: '7',
          payer,
          recipient,
          token,
          quantity: '2',
          amount: '2000000',
          platformFee: '50000',
          passTokenId: '7',
          refundDeadline: '1800000000',
          intentDigest,
        },
      },
    });
  });

  it('quarantines unknown ABI topics without exposing raw payloads', () => {
    const result = new OpenTabContractLogDecoder().decode(baseLog());
    expect(result).toMatchObject({
      kind: 'quarantined',
      reasonCode: 'EVENT_ABI_UNKNOWN',
      safeDetails: { topic0: `0x${'9'.repeat(64)}`, contract: contract.toLowerCase() },
    });
    expect(JSON.stringify(result)).not.toContain(txHash);
  });

  it('produces a stable digest that changes with canonical log position', () => {
    const first = baseLog();
    expect(digestRawLog(first)).toBe(digestRawLog({ ...first }));
    expect(digestRawLog(first)).not.toBe(digestRawLog({ ...first, logIndex: '4' }));
  });

  it('covers every event emitted by the generated checkout, pass, and split ABIs', () => {
    const emitted = new Set<string>();
    for (const file of [
      '../../../packages/contracts/abi/OpenTabCheckout.json',
      '../../../packages/contracts/abi/OpenTabPass1155.json',
      '../../../packages/contracts/abi/OpenTabSplitReimbursement.json',
    ]) {
      const raw: unknown = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
      if (!Array.isArray(raw)) throw new Error('Generated contract ABI is invalid');
      for (const item of raw) {
        if (
          typeof item === 'object' &&
          item !== null &&
          (item as { type?: unknown }).type === 'event' &&
          typeof (item as { name?: unknown }).name === 'string'
        ) {
          emitted.add((item as { name: string }).name);
        }
      }
    }
    const decoded = new Set<string>(
      OPEN_TAB_EVENT_ABI.filter((item) => item.type === 'event').map((item) => item.name),
    );
    expect([...emitted].filter((name) => !decoded.has(name))).toEqual([]);
  });
});
