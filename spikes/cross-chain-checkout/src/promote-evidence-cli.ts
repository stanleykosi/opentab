import { promotePendingLiveEvidence } from './live-driver.js';

const positional = process.argv.slice(2).filter((value) => value !== '--');
if (positional.length !== 1 || positional[0] === undefined) {
  throw new Error('Exactly one protected .pending.json evidence path is required');
}

const secret = process.env.LIVE_ACCEPTANCE_ATTESTATION_SECRET;
if (secret === undefined || secret.length < 32) {
  throw new Error('LIVE_ACCEPTANCE_ATTESTATION_SECRET is required for promotion');
}

const target = promotePendingLiveEvidence(positional[0], secret);
process.stdout.write(`${JSON.stringify({ status: 'promoted', target })}\n`);
