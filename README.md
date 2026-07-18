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

- Vercel runs `apps/web` and its API routes on the pinned Node 25.0.0 profile
  with pnpm 9.15.1 and the frozen monorepo lockfile.
- Railway runs the indexer image on exact Node 25.0.0 and pnpm 9.15.1.
- Supabase provides dedicated PostgreSQL. Vercel uses its transaction pooler;
  the indexer and controlled jobs use direct/session connections with separate
  least-privilege roles.
- One authenticated TLS Redis endpoint is shared by Vercel and Railway; Upstash
  Redis is the default documented choice.

For a new database, paste
[`SUPABASE_SQL_EDITOR_SETUP.sql`](SUPABASE_SQL_EDITOR_SETUP.sql) into the
Supabase SQL Editor. For the already-created OpenTab database, paste only
[`SUPABASE_SQL_EDITOR_PARTICLE_CERTIFICATION.sql`](SUPABASE_SQL_EDITOR_PARTICLE_CERTIFICATION.sql).
Vercel must use the `opentab_runtime` transaction-pooler URL on port `6543`;
Railway must use the separate `opentab_indexer` session/direct URL on port
`5432`.

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
This is deployment evidence, not a payment claim: payment activation is proven
only by its recorded Particle operation and confirmed `OrderPaid` settlement.

### Railway dashboard handoff

Create the indexer from the GitHub repository with config path
`/railway.indexer.json` and one replica. GitHub pushes automatically redeploy
both Railway and Vercel. Railway needs a public domain only for the
`/health/live` and `/health/ready` operator checks. Configure:

```text
APP_ENV=demo-mainnet
DATABASE_URL_INDEXER=<Supabase opentab_indexer session/direct URL>
REDIS_URL=<shared authenticated rediss:// URL>
ARBITRUM_RPC_URL=<authenticated Arbitrum One primary RPC>
PARTICLE_LIVE_ENABLED=true
NEXT_PUBLIC_PARTICLE_PROJECT_ID=<Particle project ID>
NEXT_PUBLIC_PARTICLE_CLIENT_KEY=<Particle client key>
NEXT_PUBLIC_PARTICLE_APP_UUID=<Particle app UUID>
```

Chain `42161`, native USDC, checkout/pass/split addresses, PublicNode fallback,
and block `484866936` are source defaults documented in
[`42161.public.env`](packages/contracts/deployments/42161.public.env); they are
not additional mandatory Railway variables.

`INDEXER_ENABLED`, writes, reconciliation, chain `42161`, native USDC,
checkout/pass/split addresses, PublicNode fallback, and block `484866936` are
safe source defaults rather than dashboard variables.

Railway's deployment health check uses `/health/live`, because a newly started
worker is alive while it catches up from the deployment block. During that
catch-up, `/health/ready` correctly returns HTTP 503 with reason `starting` or
`lagging`; during a rolling deployment it may briefly report `standby` while
the previous container owns the single-active-worker lease. Standby is live,
does not count as a scan failure, and takes over automatically after handoff.
Wait for HTTP 200 with `"ready": true` before payment activation. The
reconciliation worker starts safely without a profile and discovers each new
immutable Supabase certification stage within 15 seconds—no Railway restart or
profile environment-variable copy is required.

No Magic secret, DID token, KMS credential/identifier, private key, session
secret, or Vercel OIDC credential belongs in the Railway indexer.

### One-time payment activation

Push the configured GitHub branch and wait for its automatic Vercel and Railway
deployments. Set `PARTICLE_LIVE_ENABLED=true` and `PAYMENTS_ENABLED=true` on
Vercel before that deployment; the database profile gate still keeps ordinary
customer checkout closed until activation succeeds. Visit `/operator/particle`,
sign in with the Magic payment-operator account, and enter
`PARTICLE_CERTIFICATION_TOKEN`. The same strong value must be stored as the
server-only Vercel environment variable; it must never use a `NEXT_PUBLIC_`
name. Leaving it unset now keeps normal APIs online but disables this privileged
activation/rotation action.

The page presents one resumable activation journey. Select an existing active
product priced at no more than 1 USDC, or let OpenTab create its fixed 0.10-USDC
activation item. Creating the item on a fresh account requires three exact
Magic-approved setup transactions, so the displayed EOA needs a small Arbitrum
ETH fee balance. The final screen shows the exact activation amount and route
fees before the single Particle payment approval. The EOA also needs enough
supported non-Arbitrum value to cover that payment and its route fees.

The profile is stored centrally in Supabase and bound to the Particle project,
Arbitrum contracts/token, operator subject, delegate code hash, source-token
policy, and activation item. It is deliberately reused across ordinary Git
redeploys during this run. Railway and every warm Vercel instance reload it
automatically. Normal checkout opens only after Railway has indexed the
confirmed `OrderPaid` event and issued the pass; Particle success by itself is
not sufficient. Customers never repeat project activation.

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
EOA dedicated only to EIP-712 order intents; it holds no customer or merchant
funds. The protected payment-activation flow may use that key from a Vercel encrypted
Sensitive variable only under `APP_ENV=demo-mainnet`, with
`DEMO_PRIVATE_KEY_ORDER_SIGNER_ENABLED=true` and
`ORDER_SIGNER_MODE=private-key`. Preview, staging, and production still reject
private-key order signers; production requires a managed remote signer.

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
