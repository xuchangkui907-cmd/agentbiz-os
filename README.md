# AgentBiz OS

**Multi-Agent Autonomous Business Operating System**

**Let AI Run the Business. Let NEAR Govern the Money.**

AgentBiz OS is an AI-agent-oriented business operating system that brings business roles, orders, suppliers, treasury operations, delivery verification, and financial approval into one workflow.

Built on **NEAR Protocol**, AgentBiz OS combines coordinated business operations with programmable financial controls. Agents operate within explicitly authorized permissions and spending limits, while the smart contract enforces escrow, delivery verification, approval, and settlement rules.

## Live Project and Demo

- **Live Application:** https://agentbiz.verbodesk.com/
- **X Demo Post:** https://x.com/PeterGrade2131/status/2121568927038005342
- **Full Demo Video:** Available through the X post.
- **Network:** NEAR Testnet
- **Contract:** `agentbiz.stormxu.testnet`
- **Contract Explorer:** https://testnet.nearblocks.io/address/agentbiz.stormxu.testnet

## Verified NEAR Testnet Transactions

AgentBiz OS has completed an end-to-end business settlement workflow using real NEAR Testnet contract calls.

**Demo Order:** `AGENTBIZ-AI-13dbb808-42f4-498d-9c12-8e694913e3f6`

**Escrow Amount:** 0.01 NEAR

**Delivery SHA-256:**
`407817cbcfb8f8e909a56073b7d97ffdd39d437a0f40bac1643fa611c97f0b31`

| Workflow | Contract Method | Confirmed Transaction |
|---|---|---|
| Create escrow | `create_escrow` | [View transaction](https://explorer.testnet.near.org/transactions/C9k3FxA1NMhcfUyUyk7eMAtaHyoNhrMeszgT9uzqUfDH) |
| Submit delivery | `submit_delivery` | [View transaction](https://explorer.testnet.near.org/transactions/D5ynNWRFMDcCdJbnQgbpZc7yc2sEj3G2bpeSnsiK7vWn) |
| Approve delivery | `approve_delivery` | [View transaction](https://explorer.testnet.near.org/transactions/Cm58xajxWAS5UhhMFNaxiAPegUZhJVf56RXqyKCuJKb9) |
| Release escrow | `release` | [View transaction](https://explorer.testnet.near.org/transactions/565dNt2YHFo6C69T59KSsNqXSCb85MGMaUJaEb3BcgNb) |

The final dashboard showed the order as **Released**, locked escrow at **0.0000 NEAR**, and **0 active orders** for the completed workflow.

**Transaction signing:** The demonstrated business-role transactions were signed by their designated NEAR accounts and submitted using NEAR CLI. The browser wallet connection is a separate integration. These transactions are not represented as browser-wallet-signed transactions.

## Business Roles

1. **Owner** — Oversees the business, manages agent and finance permissions, and monitors treasury operations.
2. **AI Agent** — Coordinates business tasks and initiates authorized orders.
3. **Supplier** — Fulfills assigned orders and submits delivery evidence with SHA-256 verification.
4. **Finance** — Independently verifies delivery evidence, approves results, and initiates escrow release.

The separation of these roles helps prevent a single participant from controlling the entire procurement and payment process.

## Core Capabilities

### Multi-Agent Management

- Register and manage agent permissions.
- Authorize or revoke agents through the contract owner.
- Configure per-agent spending limits.
- Read authorization and spending-limit state from NEAR.
- Separate agent permissions from finance approval authority.

### On-Chain Treasury

- Deposit NEAR into the enterprise treasury.
- Query available treasury funds.
- Create supplier escrows using authorized transactions.
- Enforce available-balance and authorization checks.
- Track escrow amounts and settlement states.

### Orders and Escrow

1. An authorized agent creates an order.
2. The contract validates permissions, spending limits, and available funds.
3. Funds are locked in escrow.
4. The supplier submits delivery information and its SHA-256 hash.
5. Finance independently verifies the delivery hash.
6. Finance approves the delivery.
7. Finance initiates payment release.
8. The contract processes settlement and updates the order state.

The contract also supports refunds for eligible orders.

### Supplier Portal

- View relevant orders.
- Submit delivery information.
- Submit SHA-256 delivery hashes.
- Track delivery and escrow status.

Delivery submission is restricted to the supplier assigned to the order.

### Independent Finance Approval

- Owner-controlled finance approver allowlist.
- Independent delivery verification.
- Contract-enforced finance authorization.
- Separation between agent execution and financial approval.
- Protection against unauthorized approval and release.

### Settlement Reconciliation

NEAR settlement involves asynchronous cross-account transfers and callbacks.

AgentBiz OS includes:

- Release-attempt tracking.
- Asynchronous payment callbacks.
- Escrow state protection when settlement cannot be confirmed.
- Independent finance reconciliation.
- Distinct authorized approvers for two-party reconciliation.
- Protection against stale callbacks and duplicate reconciliation attempts.

### Business Dashboard

- Business overview and active orders.
- Agent registry and permissions.
- Treasury information.
- Order and escrow status.
- Supplier delivery information.
- Finance approval and release operations.
- Transaction references and chain audit information.

## Application Modules

| Module | Purpose |
|---|---|
| Dashboard | Business overview, treasury and order activity |
| AI Agents | Agent registry, authorization and spending limits |
| Orders | On-chain orders and escrow lifecycle |
| Supplier Portal | Delivery submission and fulfillment |
| Finance Desk | Delivery verification, approval and release |

## Smart Contract

The Rust smart contract is located in `contract/`.

| Method | Description |
|---|---|
| `deposit` | Deposit NEAR into the enterprise treasury |
| `create_escrow` | Create an order and lock supplier funds |
| `submit_delivery` | Submit supplier delivery evidence |
| `approve_delivery` | Verify the delivery SHA-256 hash |
| `release` | Initiate escrow settlement |
| `refund` | Refund an eligible escrow |
| `set_agent` | Manage agent authorization |
| `set_finance_approver` | Manage finance approvers |
| `reconcile_release` | Reconcile an asynchronous release outcome |
| `get_agent_limit` | Read an agent's spending limit |
| `get_escrow` | Read escrow details |
| `get_treasury_available` | Read available treasury funds |

## Technology Stack

- **Frontend:** React, TanStack Start, TypeScript, Tailwind CSS
- **Backend:** Node.js, server-side application services
- **Database:** PostgreSQL
- **Blockchain:** NEAR Protocol
- **Smart Contract:** Rust, NEAR SDK
- **Wallet Integration:** HOT Labs NEAR Connect
- **Chain Data:** NEAR RPC and FastNEAR indexing
- **Verification:** SHA-256
- **Testing:** TypeScript application tests and Rust contract sandbox tests

## Repository Structure

```text
agentbiz-os/
├── contract/
│   ├── src/
│   │   └── lib.rs
│   └── sandbox-tests/
├── server/
├── src/
│   ├── lib/
│   │   ├── agentbiz/
│   │   └── near/
│   └── routes/
├── scripts/
├── package.json
└── README.md
```

## Running Locally

Requirements:

- Node.js 22+
- npm
- PostgreSQL
- NEAR Testnet wallet/account for operations requiring transaction signatures

Install dependencies:

```bash
npm ci
```

Configure the local `.env` file using `.env.example` as a reference. Never commit private keys, wallet credentials, database passwords, or production secrets.

Run the application:

```bash
npm run dev
```

Quality checks:

```bash
npm run lint
npm run typecheck
npm test
```

## Security Model

AgentBiz OS uses smart-contract-enforced controls rather than relying exclusively on frontend checks.

Key security boundaries include:

- Owner-controlled agent authorization.
- Per-agent spending limits.
- Independent finance approver authorization.
- Separation between agent execution and financial approval.
- Supplier-only delivery submission.
- SHA-256 delivery hash verification.
- Escrow state validation.
- Asynchronous settlement callback protection.
- Release-attempt tracking and independent reconciliation.

The smart contract is the authority for on-chain permissions and settlement outcomes. Selecting a business role in the application does not itself authorize a blockchain transaction.

## Project Scope and Limitations

AgentBiz OS demonstrates a controlled multi-agent business operating environment with real NEAR Testnet contract interactions.

It combines business application workflows, role-based permissions, treasury management, supplier delivery verification, and programmable settlement.

The current implementation is a testnet-stage project. It is not presented as a production-ready financial service, an unrestricted autonomous agent marketplace, or a production mainnet payment network.

## Hackathon Focus

- **Agents:** Coordinated business agents with explicit permissions and spending limits.
- **Business:** An integrated operating environment for orders, suppliers, treasury, and finance.
- **Security:** Contract-enforced authorization, independent approval, escrow protection, delivery verification, and settlement reconciliation.
- **Blockchain:** Real NEAR Testnet transactions with independently verifiable smart-contract execution.

---

**AgentBiz OS — Autonomous Business. Verifiable Finance.**
