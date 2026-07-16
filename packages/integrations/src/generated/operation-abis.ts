// biome-ignore-all format: generated from audited contract ABI
// Generated from packages/contracts/abi by scripts/generate-operation-abis.mjs.
// Do not hand-edit. Run the package abi:generate command after contract changes.

export const openTabCheckoutOperationAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "payout",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "metadataHash",
        "type": "bytes32"
      }
    ],
    "name": "createMerchant",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "merchantId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "merchantId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "payout",
        "type": "address"
      }
    ],
    "name": "updateMerchantPayout",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "merchantId",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "metadataHash",
        "type": "bytes32"
      }
    ],
    "name": "updateMerchantMetadata",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "merchantId",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "active",
        "type": "bool"
      }
    ],
    "name": "setMerchantActive",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "merchantId",
            "type": "uint256"
          },
          {
            "internalType": "uint128",
            "name": "unitPrice",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "startsAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "endsAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "maxSupply",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "maxPerWallet",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "loyaltyPoints",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "refundWindow",
            "type": "uint32"
          },
          {
            "internalType": "bytes32",
            "name": "metadataHash",
            "type": "bytes32"
          },
          {
            "internalType": "string",
            "name": "passUri",
            "type": "string"
          }
        ],
        "internalType": "struct OpenTabCheckout.ProductInput",
        "name": "input",
        "type": "tuple"
      }
    ],
    "name": "createProduct",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "productId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "productId",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "uint128",
            "name": "unitPrice",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "startsAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "endsAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "maxSupply",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "maxPerWallet",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "loyaltyPoints",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "refundWindow",
            "type": "uint32"
          },
          {
            "internalType": "bytes32",
            "name": "metadataHash",
            "type": "bytes32"
          },
          {
            "internalType": "string",
            "name": "passUri",
            "type": "string"
          }
        ],
        "internalType": "struct OpenTabCheckout.ProductUpdate",
        "name": "update",
        "type": "tuple"
      }
    ],
    "name": "updateProduct",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "productId",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "active",
        "type": "bool"
      }
    ],
    "name": "setProductActive",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "orderKey",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "refund",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "merchantId",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "expectedPayout",
        "type": "address"
      }
    ],
    "name": "withdrawMerchant",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
export const openTabSplitOperationAbi = [
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "paymentKey",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "splitDigest",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "originalOrderKey",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "payer",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "beneficiary",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          },
          {
            "internalType": "uint64",
            "name": "validAfter",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "validUntil",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "metadataHash",
            "type": "bytes32"
          }
        ],
        "internalType": "struct OpenTabSplitReimbursement.SplitIntent",
        "name": "intent",
        "type": "tuple"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "reimburse",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "paymentKey",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "splitDigest",
        "type": "bytes32"
      }
    ],
    "name": "revokePaymentKey",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
