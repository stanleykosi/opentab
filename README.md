<p align="center">
  <img src="apps/web/public/brand/opentab-logo.svg" alt="OpenTab" width="260" />
</p>

# OpenTab

OpenTab is a mobile-first checkout platform for events, cafés, pop-up shops, and
creators. A merchant creates a checkout link or QR code. A customer signs in
with Google or email, reviews one total, and approves one payment.

The customer does not need a browser wallet extension. The customer also does
not need to bridge funds, change a network, or obtain Arbitrum gas.

Magic provides the embedded wallet and customer authentication. Particle
Universal Accounts finds eligible balances and routes the payment. OpenTab
settles native USDC through its contracts on Arbitrum One. OpenTab marks an
order as paid only after it confirms the canonical `OrderPaid` event.

[Open OpenTab](https://opentab-opal.vercel.app) ·
[View system status](https://opentab-opal.vercel.app/status) ·
[Read the API definition](openapi/opentab.openapi.yaml)

## Core capabilities

### For customers

- Sign in with Google or an email one-time password.
- Use an embedded wallet without a browser extension or seed phrase.
- View eligible balances as one available amount.
- Review the item price, payment cost, maximum total, and quote expiry.
- Approve one payment without a manual bridge or network change.
- Receive a durable receipt and a non-transferable pass.
- View loyalty progress and refund status.
- Create private links for group reimbursements.

### For merchants

- Create a merchant profile and a product catalog.
- Set a USDC price, inventory limit, sale period, and reward value.
- Publish a checkout link and a QR code.
- Track orders, revenue, fees, refunds, and available settlement funds.
- Export order data in CSV format.
- Refund eligible orders.
- Withdraw confirmed settlement funds.
- Configure customer loyalty rewards.

### For operators

- Pause each money operation with an independent feature switch.
- Monitor service health, payment state, indexer lag, and reconciliation.
- Use separate roles for administration, pausing, fees, merchants, and signing.
- Rebuild database projections from canonical Arbitrum events.
- Use redacted logs that keep a correlation path for each payment.

## How a payment works

1. The merchant creates a product and publishes its checkout link.
2. The customer opens the link or scans the QR code.
3. Magic authenticates the customer and opens the embedded EOA.
4. OpenTab configures Particle in EIP-7702 mode for the same EOA.
5. OpenTab checks the available supported balances.
6. The server creates the order and fixes the amount and destination.
7. Particle prepares a route to native USDC on Arbitrum One.
8. OpenTab shows the exact purchase details and the payment cost.
9. The customer approves the payment with Magic.
10. Particle routes the value and calls the OpenTab checkout contract.
11. The contract records the order and issues the customer pass.
12. The indexer confirms the canonical `OrderPaid` event.
13. OpenTab shows the paid receipt.

A Particle submission is not proof of payment. The confirmed Arbitrum event is
the payment record.

## Architecture

```mermaid
flowchart LR
    Customer[Customer] --> Web[Next.js web application]
    Merchant[Merchant] --> Web
    Web --> Services[Application services]
    Web --> Magic[Magic embedded wallet]
    Services --> Integrations[Typed integration adapters]
    Integrations --> Particle[Particle Universal Accounts]
    Integrations --> RPC[Arbitrum RPC providers]
    Services --> Database[(PostgreSQL)]
    Services --> Redis[(Redis)]
    Particle --> Arbitrum[Arbitrum One]
    Arbitrum --> Contracts[OpenTab contracts]
    Indexer[Indexer and reconciler] --> Arbitrum
    Indexer --> Database
```

OpenTab uses a ports-and-adapters design. User-interface modules do not create
Magic or Particle SDK clients. Application services control the use cases.
Integration adapters validate vendor data and map vendor errors to stable
OpenTab errors.

Arbitrum events are the authority for paid, refunded, and withdrawn states.
PostgreSQL stores workflow data and query projections. The indexer uses stable
event keys, block hashes, confirmation depth, and reorg recovery. OpenTab uses
`bigint` or integer strings for all token base units.

### Main technology

| Area | Technology |
| --- | --- |
| Web application | Next.js 16, React 19, TypeScript 6 |
| User interface | Tailwind CSS 4, XState, accessible React components |
| Wallet and identity | Magic Embedded Wallet |
| Cross-network payment | Particle Universal Accounts with EIP-7702 |
| Chain access | viem, with ethers at the required Magic signing boundary |
| Settlement | Arbitrum One and native USDC |
| Contracts | Solidity, Foundry, OpenZeppelin Contracts |
| Data | PostgreSQL, Drizzle ORM, Redis, BullMQ |
| Repository | pnpm and Turborepo |

### Repository layout

| Path | Purpose |
| --- | --- |
| `apps/web` | Customer, merchant, account, receipt, status, and API surfaces |
| `apps/indexer` | Arbitrum event indexing and payment reconciliation |
| `packages/application` | Product use cases and provider-independent ports |
| `packages/integrations` | Magic, Particle, Arbitrum, sponsor, and signer adapters |
| `packages/shared` | Domain types, schemas, identifiers, money, and error codes |
| `packages/db` | Database schema, migrations, repositories, and queues |
| `packages/contracts` | Solidity contracts, Foundry tests, and deployment data |
| `packages/ui` | Accessible design components and product presentation |
| `packages/observability` | Structured logs, telemetry, metrics, and redaction |
| `openapi` | The OpenTab HTTP API definition |
| `deployments` | Public deployment manifests |

## Smart contracts

OpenTab uses non-upgradeable contracts on Arbitrum One. The settlement token is
[native USDC](https://arbiscan.io/token/0xaf88d065e77c8cC2239327C5EDb3A432268e5831).

| Contract | Address | Purpose |
| --- | --- | --- |
| `OpenTabCheckout` | [`0x237E…ee91`](https://arbiscan.io/address/0x237E5Da5E0a1F7230E6AE93D737b9cecbcfDee91) | Products, orders, USDC settlement, refunds, withdrawals, and loyalty |
| `OpenTabPass1155` | [`0x56CC…568B`](https://arbiscan.io/address/0x56CCBeC6D08f561eCF117964FAB385CBf90A568B) | Non-transferable receipts and passes |
| `OpenTabSplitReimbursement` | [`0x7EF7…049c`](https://arbiscan.io/address/0x7EF7efa8a53530dEa3F077691422AAbEB183049c) | Signed group reimbursements |

Sourcify has an exact source match for each contract. The public manifest
contains the complete addresses, transaction hashes, source links, code hashes,
roles, and chain settings. See [`deployments/42161.json`](deployments/42161.json).

## Run OpenTab locally

### Requirements

- Git
- Node.js `25.0.0`
- pnpm `9.15.1`
- Foundry `1.7.1`
- Docker Engine with Docker Compose, or local PostgreSQL 17 and Redis 8
- Chromium for the browser test suite

### Install the project

Run these commands from the repository root:

```bash
bash scripts/verify-prerequisites.sh
pnpm install --frozen-lockfile
./scripts/bootstrap-contracts.sh
docker compose up -d postgres redis
```

Set the local sandbox environment:

```bash
export APP_ENV=local
export NEXT_PUBLIC_APP_ENV=local
export NEXT_PUBLIC_APP_ORIGIN=http://localhost:3000
export PROVIDER_MODE=deterministic
export DETERMINISTIC_DEMO_ENABLED=true
export DATABASE_URL=postgresql://opentab:opentab@127.0.0.1:5432/opentab
export REDIS_URL=redis://127.0.0.1:6379
```

Prepare the database and add the sample catalog:

```bash
pnpm --filter @opentab/db db:migrate
DEMO_SEED_CONFIRMATION=seed-opentab-deterministic-demo \
DEMO_SEED_SECRET_PEPPER="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")" \
pnpm db:seed
```

Start the web application and the local services:

```bash
pnpm dev
```

Open <http://localhost:3000>. The local sandbox uses synthetic records and
deterministic provider responses. It does not send a real payment.

## Configuration

Use [`.env.example`](.env.example) as the deployment configuration template.
It separates shared values, web values, and indexer values. Enter secrets only
in the secret manager for the target environment.

Apply these rules to every deployment:

- Keep Magic secret keys, signer keys, session secrets, and private RPC URLs on
  the server.
- Use only public vendor identifiers in `NEXT_PUBLIC_*` variables.
- Use separate database roles for the web application, indexer, and migrations.
- Use independent primary and fallback Arbitrum RPC providers.
- Keep payment, sponsor, refund, withdrawal, and split switches off until their
  required configuration is valid.
- Use a managed signer for a production deployment.
- Never reuse a deployer, administrator, sponsor, merchant, or customer key.

The application validates its environment at startup. It does not enable a
money operation when a required value is absent or invalid.

## API and service health

The HTTP API uses the `/api/v1` base path. The OpenAPI file defines the request,
response, authentication, and error schemas:

- [OpenAPI definition](openapi/opentab.openapi.yaml)
- Liveness: `/api/health`
- Readiness: `/api/v1/ready`
- Product status: `/status`

Mutation routes require the correct session and authorization. Browser
mutations also use origin checks, CSRF protection, rate limits, and idempotency
keys.

## Verification

Use the following commands to check a change:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

Run the complete repository check:

```bash
pnpm verify
```

Run the release check when you change a security, payment, contract, or
deployment boundary:

```bash
pnpm verify:release
```

Run contract checks separately when you change Solidity code:

```bash
pnpm contracts:fmt:check
pnpm contracts:build
pnpm contracts:test
pnpm contracts:coverage
pnpm contracts:slither
```

The test system includes unit, integration, browser, accessibility, contract,
fuzz, invariant, fork, security, and failure-recovery checks.

## Security model

- The server validates each Magic DID token before it creates a session.
- The server stores only a hash of each opaque session token.
- Secure deployments use `Secure`, `HttpOnly`, and `SameSite` cookies.
- The server fixes each payment amount, token, destination, and contract call.
- OpenTab verifies the EIP-7702 chain, target, nonce, and code before use.
- OpenTab records provider operations before it waits for finality.
- The indexer checks the receipt, decoded event, block hash, and confirmation
  depth.
- Smart contracts use replay protection, exact accounting, role separation,
  pause controls, and reentrancy protection.
- Logs redact tokens, cookies, email addresses, IP addresses, signatures, keys,
  and vendor payloads.
- Feature switches can stop new money operations without removing access to
  existing receipts and reconciliation.

Do not put credentials, private keys, wallet tokens, session cookies, or raw
signatures in an issue, log, fixture, screenshot, or support message. Send a
sensitive security report to the repository owner through a private channel.

## License

This repository is unlicensed. No permission to copy, modify, or distribute the
source is granted unless the repository owner gives written permission.
