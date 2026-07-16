import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'README.md',
  'START_HERE.md',
  'PROJECT_REQUEST.md',
  'AGENTS.md',
  'PRODUCT_REQUIREMENTS.md',
  'FILE_INDEX.md',
  'VALIDATION_REPORT.md',
  'TECHNICAL_SPECIFICATION.md',
  'ARCHITECTURE.md',
  'IMPLEMENTATION_PLAN.md',
  'TASKS.md',
  'TRACEABILITY_MATRIX.md',
  'PRODUCTION_READINESS_CHECKLIST.md',
  'codex/CODEX_EXECUTION_PLAYBOOK.md',
  'codex/PHASE_PROMPTS.md',
  'docs/03-integrations/CROSS_CHAIN_CHECKOUT_SPIKE.md',
  'docs/06-quality/SECURITY_THREAT_MODEL.md',
  'docs/08-submission/EVIDENCE_MATRIX.md',
  'docs/09-vendor/SOURCE_INDEX.md',
  'openapi/opentab.openapi.yaml',
  '.env.example',
];
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Missing required files:\n${missing.map((x) => `- ${x}`).join('\n')}`);
  process.exit(1);
}
for (const file of required.filter((x) => x.endsWith('.md'))) {
  if (fs.statSync(path.join(root, file)).size < 100) {
    console.error(`Required document is unexpectedly small: ${file}`);
    process.exit(1);
  }
}
console.log(`Documentation structure valid (${required.length} required artifacts).`);
