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
Firefox and WebKit projects are documented in
[the test strategy](docs/06-quality/TEST_STRATEGY.md); WebKit currently needs
the host libraries recorded in [BLOCKERS.md](BLOCKERS.md).

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

Validate configured Supabase URLs with `pnpm supabase:check:target`. The full
copy-pasteable sequence is in [the deployment handoff](03_DEPLOYMENT_AFTER_BUILD.md)
and the database-specific controls are in
[the Supabase guide](docs/07-operations/SUPABASE_POSTGRES.md).

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

See [BLOCKERS.md](BLOCKERS.md) for external gates and
[docs/03-integrations/CROSS_CHAIN_CHECKOUT_SPIKE.md](docs/03-integrations/CROSS_CHAIN_CHECKOUT_SPIKE.md)
for the guarded acceptance procedure.

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

- [Architecture](ARCHITECTURE.md)
- [Technical specification](TECHNICAL_SPECIFICATION.md)
- [API specification](docs/05-backend/API_SPECIFICATION.md)
- [Environment variables](docs/07-operations/ENVIRONMENT_VARIABLES.md)
- [Security threat model](docs/06-quality/SECURITY_THREAT_MODEL.md)
- [Deployment handoff](03_DEPLOYMENT_AFTER_BUILD.md)
- [Final build report](FINAL_BUILD_REPORT.md)
- [Evidence matrix](docs/08-submission/EVIDENCE_MATRIX.md)

The implementation is original to OpenTab. Dependency licenses and materially
adapted references are recorded in [LICENSE_NOTES.md](LICENSE_NOTES.md) and the
generated [third-party notices](THIRD_PARTY_NOTICES.md).
