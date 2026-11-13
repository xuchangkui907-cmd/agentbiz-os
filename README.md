# AgentBiz OS

**Multi-Agent Autonomous Business Operating System**

**Let AI Run the Business. Let NEAR Govern the Money.**

AgentBiz OS is an on-chain business operating system that coordinates AI agents, business orders, suppliers, treasury operations, and independent financial approvals.

Built on **NEAR Protocol**, AgentBiz OS combines autonomous business workflows with programmable financial controls. Agents can operate within explicitly authorized permissions and spending limits, while the smart contract enforces escrow, delivery verification, and settlement rules.

**Network:** NEAR Testnet
**Contract:** `agentbiz.stormxu.testnet`
**Owner:** `stormxu.testnet`

---

## Core Capabilities

### 1. Multi-Agent Management

Manage a coordinated AI agent cluster from a unified business dashboard.

- Register and manage agent permissions.
- Authorize or revoke agents through the contract owner.
- Configure per-agent spending limits.
- Read authorization and spending-limit state directly from NEAR.
- Keep agent permissions separate from finance approval authority.
- Monitor agent accounts and business activity.

The contract enforces role boundaries: the owner and finance approvers cannot simultaneously hold agent permissions.

### 2. On-Chain Treasury

Manage enterprise procurement funds through the NEAR smart contract.

- Deposit NEAR into the enterprise treasury.
- Query available treasury funds from the contract.
- Create supplier escrows using real wallet-signed transactions.
- Enforce available-balance and authorization checks.
- Track escrow amounts and settlement states.

### 3. Orders and Escrow

Create and monitor business orders backed by on-chain escrow.

The contract supports the following lifecycle:

1. An authorized agent creates an order and specifies its supplier and payment amount.
2. The contract validates permissions, spending limits, and available funds.
3. Funds are locked in escrow.
4. The supplier submits delivery evidence and its SHA-256 hash.
5. An authorized finance approver independently verifies the submitted hash.
6. Finance initiates the release.
7. The contract executes the supplier payment and processes the release callback.
8. The order state is updated according to the settlement result.

The contract also supports refunds for eligible orders.

### 4. Supplier Portal

Suppliers can participate in the order fulfillment workflow.

- View relevant orders.
- Submit delivery information.
- Submit SHA-256 delivery hashes.
- Track delivery and escrow status.

Delivery submission is restricted to the supplier assigned to the order.

### 5. Independent Finance Approval

Financial approval is separated from agent execution.

- The contract owner manages the finance approver allowlist.
- Finance approvers independently verify delivery hashes.
- Suppliers cannot approve their own deliveries.
- Agents cannot approve their own orders.
- The contract checks finance authorization when approving and releasing funds.
- Revoked approvers cannot continue exercising finance privileges.

This separation reduces the risk of a single agent controlling both procurement and payment approval.

### 6. Settlement Reconciliation

NEAR contract settlement involves asynchronous cross-account transfers and callbacks.

AgentBiz OS includes contract-level release-attempt tracking and independent reconciliation logic.

- Track individual release attempts.
- Process asynchronous payment callbacks.
- Preserve escrow state when settlement cannot be confirmed.
- Support independent finance reconciliation.
- Require distinct authorized approvers for the two-party reconciliation process.
- Prevent stale callbacks and duplicate reconciliation attempts from incorrectly finalizing an order.

### 7. Business Dashboard and Chain Data

The dashboard brings business operations and finalized contract data together.

- Business overview and active orders.
- Agent registry and on-chain permissions.
- Treasury information.
- Order and escrow status.
- Supplier delivery information.
- Finance approval and release operations.
- Transaction references and chain audit information.

The server reads contract state and synchronizes order information using NEAR chain data. Database records and finalized on-chain state are represented separately so that application indexing is not confused with contract execution.

---

## Application Modules

| Module | Purpose |
|---|---|
| Dashboard | Business overview, treasury and order activity |
| AI Agents | Agent registry, authorization and spending limits |
| Orders | On-chain orders and escrow lifecycle |
| Supplier Portal | Delivery submission and order fulfillment |
| Finance Desk | Delivery verification, approval and fund release |

---

## Smart Contract

The Rust smart contract is located in `contract/`.

Key operations include:

| Method | Description |
|---|---|
| `deposit` | Deposit NEAR into the enterprise treasury |
| `create_escrow` | Create an order and lock supplier funds |
| `submit_delivery` | Submit supplier delivery evidence |
| `approve_delivery` | Verify the delivery SHA-256 hash |
| `release` | Initiate escrow settlement |
| `refund` | Refund an eligible escrow |
| `set_agent` | Manage agent authorization |
| `set_finance_approver` | Manage independent finance approvers |
| `reconcile_release` | Reconcile an asynchronous release outcome |
| `get_agent_limit` | Read an agent's spending limit |
| `get_escrow` | Read escrow details |
| `get_treasury_available` | Read available treasury funds |

The contract enforces authorization, role separation, spending limits, escrow state transitions, delivery verification, and settlement rules.

---

## Technology Stack

- **Frontend:** React, TanStack Start, TypeScript, Tailwind CSS
- **Backend:** Node.js, server-side application services
- **Database:** PostgreSQL
- **Blockchain:** NEAR Protocol
- **Smart Contract:** Rust, NEAR SDK
- **Wallet Integration:** HOT Labs NEAR Connect
- **Chain Data:** NEAR RPC and FastNEAR indexing
- **Verification:** SHA-256 delivery hashes
- **Testing:** TypeScript application tests and Rust contract sandbox tests

---

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

---

## Running Locally

### Requirements

- Node.js 22+
- npm
- PostgreSQL
- NEAR Testnet wallet for on-chain operations

### Install dependencies

```bash
npm ci
```

### Configure environment

Create a local `.env` file using `.env.example` as a reference.

Configure the PostgreSQL connection and the application settings required by your environment.

Never commit private keys, wallet credentials, database passwords, or production secrets.

### Run the application

```bash
npm run dev
```

Open the local development URL printed by the application.

### Quality checks

```bash
npm run lint
npm run typecheck
npm test
```

---

## NEAR Testnet

AgentBiz OS is deployed on NEAR Testnet.

- **Contract:** `agentbiz.stormxu.testnet`
- **Network:** NEAR Testnet
- **Contract explorer:** https://testnet.nearblocks.io/address/agentbiz.stormxu.testnet

Use a NEAR Testnet-compatible wallet and testnet funds to perform operations requiring transaction signatures.

All blockchain transactions require wallet authorization. The application does not treat a locally generated transaction identifier as proof of an on-chain transaction.

---

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

The smart contract is the authority for on-chain permissions and settlement outcomes.

---

## Project Scope

AgentBiz OS demonstrates a controlled multi-agent business operating environment with real NEAR Testnet contract interactions.

It combines business application workflows, role-based permissions, treasury management, supplier delivery verification, and programmable settlement.

The current implementation is a testnet-stage project. It is not presented as a production-ready financial service, an unrestricted autonomous agent marketplace, or a production mainnet payment network.

---

## Hackathon Focus

**Agents:** Coordinated business agents with explicit permissions and spending limits.

**Business:** An integrated operating environment for orders, suppliers, treasury, and finance.

**Security:** Contract-enforced authorization, independent approval, escrow protection, delivery verification, and settlement reconciliation.

**Blockchain:** Real NEAR Testnet transactions and verifiable smart-contract execution.

---

**AgentBiz OS — Autonomous Business. Verifiable Finance.**
