import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicJudgeProofSchema } from '../packages/shared/src/judge.ts';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'openapi', 'schemas', 'public-judge-proof.schema.json');
const generated = PublicJudgeProofSchema.toJSONSchema();
const rawDocument = `${JSON.stringify(
  {
    ...generated,
    $id: 'https://opentab.example/schemas/public-judge-proof.schema.json',
    title: 'OpenTab Public Judge Proof',
  },
  null,
  2,
)}\n`;

function formatGeneratedJson(input: string): string {
  const executable = path.join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'biome.cmd' : 'biome',
  );
  const result = spawnSync(executable, ['format', '--stdin-file-path', target], {
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0 || result.stdout.length === 0) {
    throw new Error(
      `Unable to format the generated Judge schema: ${result.stderr.trim() || result.error?.message || 'unknown formatter failure'}`,
    );
  }
  return result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`;
}

const document = formatGeneratedJson(rawDocument);

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== document) {
      process.stderr.write(
        'OpenAPI Judge proof schema is stale. Run pnpm api:schema:judge to regenerate it.\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('OpenAPI Judge proof schema matches PublicJudgeProofSchema.\n');
    }
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, document, 'utf8');
    process.stdout.write(`Updated ${path.relative(root, target)}.\n`);
  }
}

void main();
