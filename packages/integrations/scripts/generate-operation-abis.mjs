import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = path.resolve(packageRoot, '..', 'contracts', 'abi');
const outputPath = path.join(packageRoot, 'src', 'generated', 'operation-abis.ts');

const selections = [
  {
    source: 'OpenTabCheckout.json',
    exportName: 'openTabCheckoutOperationAbi',
    functions: [
      'createMerchant',
      'updateMerchantPayout',
      'updateMerchantMetadata',
      'setMerchantActive',
      'createProduct',
      'updateProduct',
      'setProductActive',
      'refund',
      'withdrawMerchant',
    ],
  },
  {
    source: 'OpenTabSplitReimbursement.json',
    exportName: 'openTabSplitOperationAbi',
    functions: ['reimburse', 'revokePaymentKey'],
  },
];

function selectedAbi(selection) {
  const sourcePath = path.join(contractsRoot, selection.source);
  const abi = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!Array.isArray(abi)) throw new Error(`${selection.source} is not an ABI array`);
  const selected = selection.functions.map((name) => {
    const entries = abi.filter((entry) => entry?.type === 'function' && entry.name === name);
    if (entries.length !== 1)
      throw new Error(`${selection.source} must contain exactly one ${name}`);
    return entries[0];
  });
  return selected;
}

const sections = selections.map(
  (selection) =>
    `export const ${selection.exportName} = ${JSON.stringify(selectedAbi(selection), null, 2)} as const;`,
);
const generated = [
  '// biome-ignore-all format: generated from audited contract ABI',
  '// Generated from packages/contracts/abi by scripts/generate-operation-abis.mjs.',
  '// Do not hand-edit. Run the package abi:generate command after contract changes.',
  '',
  ...sections,
  '',
].join('\n');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== generated) {
    console.error('Generated operation ABI module is stale.');
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated, 'utf8');
}
