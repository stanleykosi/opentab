# OpenTab

OpenTab is a mobile-first, walletless checkout and event-commerce application.
Customers authenticate with a Magic embedded wallet, see one fiat-denominated
spendable balance, and approve one purchase. Particle Universal Accounts is
configured in EIP-7702 mode to source supported cross-chain value and execute
the final payment on Arbitrum. A confirmed canonical Arbitrum contract event—not
a provider submission response—is the source of truth for payment, refund, and
withdrawal status.

The repository includes the customer and merchant web application, API and
application services, PostgreSQL schema/migrations, Redis coordination,
reorg-aware indexer, deterministic and live provider adapters, Solidity
settlement/pass/split contracts, protected live-acceptance harness, CI, and
deployment configuration.

## Product surfaces

- Public merchant storefronts, shareable product checkout links, and QR codes
- Magic Google/social authentication with email OTP fallback and opaque OpenTab sessions
- Explicit EIP-7702 readiness, constrained bootstrap sponsorship, unified balance, quote, preview, payment, and refresh recovery
- Premium receipt/pass, loyalty, privacy-safe sharing, and bounded split reimbursement
- Merchant onboarding, product lifecycle, inventory, orders, refunds, settlement withdrawals, CSV exports, and accessible metrics
- Public-safe Judge Mode containing sanitized Magic, Particle, and canonical Arbitrum evidence
- Deterministic local mode with an unmistakable demo label; risky production features default off

## Architecture

```text
apps/web                 Next.js App Router UI and HTTP API
apps/indexer             Arbitrum indexer, reconciliation, and BullMQ worker
packages/application     Provider-independent use cases and ports
packages/shared          Domain schemas, exact money, IDs, errors, chain events
packages/db              Drizzle schema, migrations, repositories, Redis coordination
packages/integrations    Magic, Particle, Arbitrum, KMS, sponsor, and fake adapters
packages/ui              Accessible OpenTab design system
packages/contracts       Foundry contracts, tests, deploy scripts, ABIs, evidence
packages/observability   Structured redacted logging and telemetry boundaries
packages/testkit         Deterministic fixtures and factories
spikes/cross-chain-checkout  Guarded credentialed compatibility/evidence harness
```

OpenTab uses exact integer strings or `bigint` for token base units. UI modules
never instantiate Magic or Particle directly. Provider operations are stored
before finality waits, and the indexer independently verifies chain, contract,
transaction receipt, decoded event fields, confirmation depth, and canonical
block hash.

## Local development

The owner-selected toolchain is pinned exactly to Node `25.0.0` and pnpm
`9.15.1`.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
cp .env.example .env.local
set -a
. ./.env.local
set +a
docker compose up -d postgres redis
pnpm --filter @opentab/db db:migrate
pnpm dev
```

The expected output is `v25.0.0` and `9.15.1`. Node 25 does not bundle
Corepack on the supported build device, so `pnpm` must be installed directly
and available on `PATH`; do not replace the repository pin with an implicit
Corepack-managed version.

The root environment file is intentionally ignored by Git. Source it into the
launching shell as shown so the web, worker, migrations, and Turbo child
processes receive one explicit local configuration; Next.js does not
automatically load a repository-root env file from `apps/web`.

Open <http://localhost:3000>. The checked-in environment example enables only
explicit local deterministic mode. It contains placeholder values, never
working credentials. If Docker is unavailable, PostgreSQL and Redis may be run
natively with the same URLs.

Useful commands:

```bash
pnpm smoke:demo
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm verify
pnpm verify:release
```

The default browser command runs 22 Chromium desktop/mobile checks. Focused
Firefox and WebKit projects are also configured; WebKit currently needs host
libraries unavailable on the validated workstation.

Contract-only checks are available through `pnpm contracts:build`,
`pnpm contracts:test`, `pnpm contracts:coverage`, and
`pnpm contracts:slither`.

## Deployment topology

- Vercel runs `apps/web` and its API routes on the isolated Node 24.x profile
  with pnpm 9.15.1 and the frozen monorepo lockfile.
- Railway runs the indexer image on exact Node 25.0.0 and pnpm 9.15.1.
- Supabase provides dedicated PostgreSQL. Vercel uses its transaction pooler;
  the indexer and controlled jobs use direct/session connections with separate
  least-privilege roles.
- One authenticated TLS Redis endpoint is shared by Vercel and Railway; Upstash
  Redis is the default documented choice.

Paste [`SUPABASE_SQL_EDITOR_SETUP.sql`](SUPABASE_SQL_EDITOR_SETUP.sql) into the
Supabase SQL Editor, then validate configured URLs with
`pnpm supabase:check:target`. Vercel must use the generated `opentab_runtime`
transaction-pooler URL on port `6543`; Railway must use the separate
`opentab_indexer` session-pooler URL on port `5432`.

## Arbitrum One deployment

The reviewed non-upgradeable contracts are deployed on Arbitrum One (`42161`)
from canonical indexer block `484866936`:

- Checkout: `0x237E5Da5E0a1F7230E6AE93D737b9cecbcfDee91`
- Pass: `0x56CCBeC6D08f561eCF117964FAB385CBf90A568B`
- Split reimbursement: `0x7EF7efa8a53530dEa3F077691422AAbEB183049c`
- Native USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`

All four deployment/binding receipts succeeded. Infura and PublicNode both
passed the keyless deployment assertions, and all three contracts have
creation/runtime `exact_match` source on Sourcify. Public runtime defaults are
recorded in
[`packages/contracts/deployments/42161.public.env`](packages/contracts/deployments/42161.public.env).
This is deployment evidence, not a payment claim: the Particle cross-chain
canary has not run and the money-moving flags remain disabled.

### Railway dashboard handoff

Create the indexer from the GitHub repository with config path
`/railway.indexer.json`, one replica, and no public domain. First deploy the
safe chain scanner with:

```text
APP_ENV=demo-mainnet
INDEXER_ENABLED=true
INDEXER_WRITES_ENABLED=true
INDEXER_RECONCILIATION_ENABLED=false
DATABASE_URL_INDEXER=<Supabase opentab_indexer session/direct URL>
REDIS_URL=<shared authenticated rediss:// URL>
ARBITRUM_RPC_URL=<authenticated Arbitrum One primary RPC>
```

Chain `42161`, native USDC, checkout/pass/split addresses, PublicNode fallback,
and block `484866936` are source defaults documented in
[`42161.public.env`](packages/contracts/deployments/42161.public.env); they are
not additional mandatory Railway variables.

After the scanner is healthy and the recorded-live Particle profile is
reviewed, switch `APP_ENV=production`, set
`INDEXER_RECONCILIATION_ENABLED=true` and `PARTICLE_LIVE_ENABLED=true`, then
add:

```text
NEXT_PUBLIC_PARTICLE_PROJECT_ID=<Particle project ID>
NEXT_PUBLIC_PARTICLE_CLIENT_KEY=<Particle client key>
NEXT_PUBLIC_PARTICLE_APP_UUID=<Particle app UUID>
PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS=<reviewed address>
PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH=<reviewed code hash>
PARTICLE_RESPONSE_PROFILE_ID=<recorded-live profile ID>
PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST=<sha256 digest>
PARTICLE_AUTH_FIXTURE_DIGEST=<sha256 digest>
PARTICLE_SUBMISSION_FIXTURE_DIGEST=<sha256 digest>
PARTICLE_STATUS_FIXTURE_DIGEST=<sha256 digest>
PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET=<verified integer>
PARTICLE_DELEGATION_PLAN_TTL_SECONDS=<reviewed seconds>
PARTICLE_ALLOWED_SOURCE_TOKENS=<exact chain:asset:token entries>
PARTICLE_SOURCE_CALL_PROFILES_JSON=<reviewed compact JSON>
```

No Magic secret, DID token, KMS credential/identifier, private key, session
secret, or Vercel OIDC credential belongs in the Railway indexer.

## Live-provider safety

Live paths fail closed unless environment validation succeeds. The default
production flags are:

```text
PAYMENTS_ENABLED=false
PARTICLE_LIVE_ENABLED=false
BOOTSTRAP_SPONSOR_ENABLED=false
BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY=true
JUDGE_MODE_ENABLED=false
MERCHANT_MUTATIONS_ENABLED=false
REFUNDS_ENABLED=false
WITHDRAWALS_ENABLED=false
SPLITS_ENABLED=false
```

Never put Magic DID tokens, private keys, session cookies, signatures, private
RPC URLs, or raw provider payloads in source or evidence. The credentialed
cross-chain harness additionally requires an explicit tiny-spend acknowledgement
and an exact maximum USDC amount. Deterministic tests are not represented as
live-chain proof.

The deployment-time order signer
`0x03981bA2a287b173A16b2c0a04088aB33AA98526` is a temporary local encrypted
EOA. It must be rotated to the reviewed AWS KMS signer before
`PAYMENTS_ENABLED=true`.

The local release bundle records the remaining external gates and guarded
acceptance procedure. It is intentionally excluded from Git by the owner's
Markdown policy.

## Contracts and payment truth

The non-upgradeable Solidity suite implements merchant/product registration,
EIP-712 order intents, replay and inventory protection, exact stable-token
accounting, refundable liabilities, pull-based merchant settlement, refunds,
withdrawals, non-transferable ERC-1155 receipts/passes, and signed split
reimbursement. Foundry unit, negative, fuzz, invariant, fork, deployment, gas,
size, coverage, and Slither evidence is stored under
[`packages/contracts/evidence`](packages/contracts/evidence).

OpenTab never marks an order paid from a Particle status alone. Only a matching,
successful, confirmed, canonical `OrderPaid` event from the configured Arbitrum
checkout contract can make the paid projection authoritative.

## Documentation and release

The local working tree retains the architecture, technical specification, API
contract, threat model, deployment handoff, final report, blocker ledger,
evidence matrix, license notes, and third-party notices. They are intentionally
excluded from Git because this repository's owner policy permits only this
Markdown file on GitHub. The implementation is original to OpenTab; runtime
manifests, migrations, ABIs, tests, and deployment evidence remain tracked in
their non-Markdown formats.
