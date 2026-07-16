import { supabaseTemplateEnvironment, verifySupabaseTarget } from './lib/supabase-target.mjs';

const usage = `Usage:
  node scripts/verify-supabase-target.mjs --template
  DATABASE_URL=<secret> \\
  DATABASE_URL_INDEXER=<secret> \\
  DATABASE_URL_MIGRATIONS=<secret> \\
  DATABASE_URL_EVIDENCE_WRITER=<secret> \\
  node scripts/verify-supabase-target.mjs
`;

if (process.argv.includes('--help')) {
  process.stdout.write(usage);
  process.exit(0);
}

const template = process.argv.includes('--template');
if (process.argv.length > (template ? 3 : 2)) {
  process.stderr.write(usage);
  process.exit(2);
}

try {
  const result = verifySupabaseTarget(template ? supabaseTemplateEnvironment() : process.env);
  process.stdout.write(
    `Supabase target topology passed: web=${result.modes.DATABASE_URL}, indexer=${result.modes.DATABASE_URL_INDEXER}, migrations=${result.modes.DATABASE_URL_MIGRATIONS}, evidence=${result.modes.DATABASE_URL_EVIDENCE_WRITER}.\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown validation failure.';
  process.stderr.write(`Supabase target check failed: ${message}\n`);
  process.exit(1);
}
