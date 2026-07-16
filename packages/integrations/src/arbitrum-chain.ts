import { defineChain } from 'viem';

/**
 * Narrow Arbitrum One descriptor used by server adapters. Keeping this local
 * prevents the aggregate `viem/chains` barrel from bundling unrelated chains
 * and their optional runtimes into web functions. Values match viem 2.55.0's
 * installed Arbitrum definition and OpenTab's reviewed network policy.
 */
export const arbitrumOneChain = defineChain({
  id: 42_161,
  name: 'Arbitrum One',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockTime: 250,
  rpcUrls: {
    default: { http: ['https://arb1.arbitrum.io/rpc'] },
  },
  blockExplorers: {
    default: {
      name: 'Arbiscan',
      url: 'https://arbiscan.io',
      apiUrl: 'https://api.arbiscan.io/api',
    },
  },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
      blockCreated: 7_654_707,
    },
  },
});
