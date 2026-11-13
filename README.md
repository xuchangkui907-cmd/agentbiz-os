# AgentBiz OS

**Autonomous AI Business & Treasury Network**

**Slogan:** Let AI Run the Business. Let NEAR Govern the Money.

**Live demo** in the preview above shows the complete 8-step commercial transaction closed loop that judges will see.

## Demo Flow (exactly as in the 8-step success criteria)

1. Customer creates $100 AI service order.
2. CEO Agent automatically generates procurement plan with hard $40 budget.
3. Three Supplier Agents (fixed-policy, different cost/ETA/delivery models) submit quotes ($25, $35, $55).
4. **Security Engine + NEAR contract both reject the $55 over-budget bid** (`ERR_OVER_BUDGET`).
5. CEO selects cheapest compliant supplier (A at $25), initiates escrow on simulated NEAR testnet (real Rust contract in `contract/` mirrors every invariant).
6. Supplier submits delivery + SHA-256 hash of content.
7. Contract verifies hash and releases funds.
8. Finance Agent generates profit report: **Revenue $100 / Expenses $25 / Profit $75**, with all transaction hashes visible.

**All key evidence is visible in UI**: rejection reason, tx hashes (SHA-256 of payload), delivery hash, treasury changes, final P&L with chain audit ledger. Dollars are simulated books; NEAR scaling (1 USD = 0.01 NEAR) fits testnet.

**This is a controlled multi-agent collaboration demo** — not an open Agent-to-Agent network or marketplace. README and UI explicitly state this. Supplier behavior is driven by distinct prompt-like policies in code. AI agents do not hold keys; only the NEAR contract governs settlement.

## Technical Architecture

- **Frontend**: TanStack Start + React + Tailwind v4 + polished cyber-finance UI (agent cards, live audit ledger with ring highlight on latest step, treasury cards, real-time progress).
- **Engine**: `src/lib/agentbiz/engine.ts` — `TreasuryContract` class that exactly mirrors `contract/src/lib.rs` invariants (budget check, hash requirement, state machine, tx simulation).
- **Contract**: Rust NEAR smart contract (`contract/`) with `create_escrow`, `submit_delivery`, `release`, pause, owner controls. Ready for testnet deployment.
- **Simulation**: In-browser deterministic run with animated steps (420ms per step for drama). SHA-256 computed client-side.
- **Honest Scope**: No real cross-chain intents, no open agent registry, no multi-tenant SaaS, no auth (single demo business). Focused on one complete, verifiable commercial loop.

## Hackathon Tracks

- **Agents**: CEO, Supplier, Security, Finance agents with distinct policies.
- **Business**: Full operating system shell with enterprise, treasury, ledger.
- **Security**: Hard on-chain/off-chain policy enforcement (budget, pause, hash verification).

## Next Steps (4-day MVP complete)

Deploy the Rust contract to NEAR testnet, replace the in-browser adapter with `near-api-js` calls (PR-ready structure exists in engine.ts comments), add real wallet connection for owner deposit/release. The visual and logic foundation is production-grade.

Built in the Grok App Builder sandbox for the Near hackathon. Ready for judging.

**Run the demo** — watch the full autonomous business cycle execute with visible chain evidence.
