#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

mkdir -p abi artifacts/errors artifacts/storage-layout

contracts=(OpenTabCheckout OpenTabPass1155 OpenTabSplitReimbursement)
for contract in "${contracts[@]}"; do
  contract_id="src/$contract.sol:$contract"
  forge inspect "$contract_id" abi --json | jq --sort-keys . > "abi/$contract.json"
  forge inspect "$contract_id" errors --json | jq --sort-keys . > "artifacts/errors/$contract.json"
  forge inspect "$contract_id" storageLayout --json | jq --sort-keys . > "artifacts/storage-layout/$contract.json"
done

jq -n --slurpfile checkout artifacts/errors/OpenTabCheckout.json \
  --slurpfile pass artifacts/errors/OpenTabPass1155.json \
  --slurpfile split artifacts/errors/OpenTabSplitReimbursement.json \
  '{OpenTabCheckout: $checkout[0], OpenTabPass1155: $pass[0], OpenTabSplitReimbursement: $split[0]}' \
  > artifacts/error-selectors.json

order_type='OrderIntent(bytes32 orderKey,address payer,address recipient,uint256 merchantId,uint256 productId,uint64 productVersion,address token,uint256 amount,uint16 platformFeeBps,uint256 platformFee,uint64 quantity,uint64 validAfter,uint64 validUntil,uint64 refundDeadline,bytes32 metadataHash)'
split_type='SplitIntent(bytes32 paymentKey,bytes32 splitDigest,bytes32 originalOrderKey,address payer,address beneficiary,address token,uint256 amount,uint64 validAfter,uint64 validUntil,bytes32 metadataHash)'
order_event='OrderPaid(bytes32,uint256,uint256,address,address,address,uint64,uint256,uint256,uint256,uint64,bytes32)'
split_event='SplitReimbursed(bytes32,bytes32,bytes32,address,address,address,uint256,bytes32)'

jq -n --arg orderType "$order_type" \
  --arg orderTypehash "$(cast keccak "$order_type")" \
  --arg orderDomainName 'OpenTab Order Intent' \
  --arg orderDomainVersion '1' \
  --arg splitType "$split_type" \
  --arg splitTypehash "$(cast keccak "$split_type")" \
  --arg splitDomainName 'OpenTab Split Reimbursement' \
  --arg splitDomainVersion '1' \
  --arg orderPaidTopic0 "$(cast keccak "$order_event")" \
  --arg splitReimbursedTopic0 "$(cast keccak "$split_event")" \
  '{
    orderIntent: {type: $orderType, typehash: $orderTypehash, domain: {name: $orderDomainName, version: $orderDomainVersion}},
    splitIntent: {type: $splitType, typehash: $splitTypehash, domain: {name: $splitDomainName, version: $splitDomainVersion}},
    events: {OrderPaid: {topic0: $orderPaidTopic0}, SplitReimbursed: {topic0: $splitReimbursedTopic0}}
  }' > artifacts/canonical-signatures.json

jq --sort-keys . artifacts/error-selectors.json > artifacts/error-selectors.json.tmp
mv artifacts/error-selectors.json.tmp artifacts/error-selectors.json
jq --sort-keys . artifacts/canonical-signatures.json > artifacts/canonical-signatures.json.tmp
mv artifacts/canonical-signatures.json.tmp artifacts/canonical-signatures.json
