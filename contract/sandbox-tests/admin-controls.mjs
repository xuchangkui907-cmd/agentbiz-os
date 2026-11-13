import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "near-workspaces";

const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const WASM_SHA256 =
  "39a6b0318ea2300cd18ccefeec7a7f163da47994cc21a50649c4595736f8085d";

let worker;

function section(name) {
  console.log("\n========== " + name + " ==========");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function call(account, contract, method, args = {}, deposit = 0n) {
  const result = await account.callRaw(contract, method, args, {
    gas: 100n * TGAS,
    attachedDeposit: deposit,
  });

  if (result.failed) {
    console.error("UNEXPECTED FAILURE:", method, result.summary());
    console.error(result.failureMessage);
    throw new Error("Unexpected failure: " + method);
  }

  console.log("SUCCESS:", method);
  return result;
}

async function expectFailure(account, contract, method, args = {}, label = method) {
  const result = await account.callRaw(contract, method, args, {
    gas: 100n * TGAS,
  });

  assert.equal(result.failed, true, "Expected failure: " + label);
  console.log("PASS: Expected rejection:", label);
  console.log("  Reason:", result.failureMessage ?? result.summary());
  return result;
}

async function viewNumber(contract, method) {
  return BigInt(await contract.view(method));
}

async function snapshot(contract) {
  return {
    treasury: await viewNumber(contract, "get_treasury_available"),
    locked: await viewNumber(contract, "get_total_locked"),
    spent: await viewNumber(contract, "get_spent_total"),
    budget: await viewNumber(contract, "get_max_budget"),
    available: await viewNumber(contract, "get_available_budget"),
  };
}

async function assertSnapshot(contract, expected, label) {
  assert.deepEqual(await snapshot(contract), expected, label);
  console.log("PASS:", label);
}

async function createAndApprove(agent, supplier, finance, contract, orderId) {
  await call(agent, contract, "create_escrow", {
    order_id: orderId,
    supplier: supplier.accountId,
    amount: ONE_NEAR.toString(),
  });

  await call(supplier, contract, "submit_delivery", {
    order_id: orderId,
    sha256_hex: hash("AgentBiz admin-controls delivery " + orderId),
  });

  await call(finance, contract, "approve_delivery", {
    order_id: orderId,
    verified_sha256_hex: hash("AgentBiz admin-controls delivery " + orderId),
  });
}

async function main() {
  section("1. Local Sandbox and formal WASM verification");

  worker = await Worker.init({ network: "sandbox" });
  const root = worker.rootAccount;

  const wasmPath = resolve("../target/near/agentbiz_treasury.wasm");
  const wasm = await readFile(wasmPath);
  const actualHash = createHash("sha256").update(wasm).digest("hex");

  assert.equal(actualHash, WASM_SHA256);
  console.log("PASS: Formal WASM hash:", actualHash);

  section("2. Create isolated accounts");

  const owner = await root.createSubAccount("admin-owner", {
    initialBalance: 20n * ONE_NEAR,
  });
  const supplier = await root.createSubAccount("admin-supplier", {
    initialBalance: 10n * ONE_NEAR,
  });
  const agent = await root.createSubAccount("admin-agent", {
    initialBalance: 10n * ONE_NEAR,
  });
  const finance = await root.createSubAccount("admin-finance", {
    initialBalance: 10n * ONE_NEAR,
  });
  const outsider = await root.createSubAccount("admin-outsider", {
    initialBalance: 10n * ONE_NEAR,
  });

  section("3. Deploy and initialize");

  const contract = await root.devDeploy(wasm, {
    initialBalance: 10n * ONE_NEAR,
    method: "new",
    args: {
      owner: owner.accountId,
      max_budget: (5n * ONE_NEAR).toString(),
    },
    gas: 100n * TGAS,
  });

  console.log("CONTRACT:", contract.accountId);

  section("4. Initial treasury and role configuration");

  await call(owner, contract, "deposit", {}, 5n * ONE_NEAR);
  await call(owner, contract, "set_agent", {
    agent: agent.accountId,
    enabled: true,
    per_order_limit: (5n * ONE_NEAR).toString(),
  });
  await call(owner, contract, "set_finance_approver", {
    account: finance.accountId,
    enabled: true,
  });

  const initial = await snapshot(contract);
  assert.deepEqual(initial, {
    treasury: 5n * ONE_NEAR,
    locked: 0n,
    spent: 0n,
    budget: 5n * ONE_NEAR,
    available: 5n * ONE_NEAR,
  });
  console.log("PASS: Initial accounting");

  section("5. Non-owner cannot change budget or reset spending");

  await expectFailure(
    agent,
    contract,
    "set_max_budget",
    { max_budget: (4n * ONE_NEAR).toString() },
    "Agent cannot change max budget",
  );

  await expectFailure(
    outsider,
    contract,
    "reset_spent_total",
    {},
    "Non-owner cannot reset spent total",
  );

  await assertSnapshot(contract, initial, "Unauthorized admin calls preserve accounting");

  section("6. Budget lower and zero boundaries");

  await expectFailure(
    owner,
    contract,
    "set_max_budget",
    { max_budget: "0" },
    "Zero budget rejected",
  );

  await call(owner, contract, "set_max_budget", {
    max_budget: (6n * ONE_NEAR).toString(),
  });

  assert.equal(
    await viewNumber(contract, "get_max_budget"),
    6n * ONE_NEAR,
  );
  console.log("PASS: Owner can increase budget");

  section("7. Complete first payment");

  await createAndApprove(
    agent, supplier, finance, contract, "admin-controls-order-1",
  );

  await call(finance, contract, "release", {
    order_id: "admin-controls-order-1",
  });

  assert.equal(
    (await contract.view("get_escrow", {
      order_id: "admin-controls-order-1",
    })).status,
    "Released",
  );

  assert.deepEqual(await snapshot(contract), {
    treasury: 4n * ONE_NEAR,
    locked: 0n,
    spent: ONE_NEAR,
    budget: 6n * ONE_NEAR,
    available: 4n * ONE_NEAR,
  });

  console.log("PASS: First payment updates spent total");

  section("8. Committed budget cannot be reduced");

  await createAndApprove(
    agent, supplier, finance, contract, "admin-controls-order-2",
  );

  await assertSnapshot(contract, {
    treasury: 3n * ONE_NEAR,
    locked: ONE_NEAR,
    spent: ONE_NEAR,
    budget: 6n * ONE_NEAR,
    available: 3n * ONE_NEAR,
  }, "Second order is locked");

  await expectFailure(
    owner,
    contract,
    "set_max_budget",
    { max_budget: (199n * ONE_NEAR / 100n).toString() },
    "Budget below spent plus locked rejected",
  );

  await call(owner, contract, "set_max_budget", {
    max_budget: (2n * ONE_NEAR).toString(),
  });

  assert.equal(
    await viewNumber(contract, "get_max_budget"),
    2n * ONE_NEAR,
  );
  console.log("PASS: Budget equal to committed amount is accepted");

  section("9. Cannot reset while an escrow is locked");

  await expectFailure(
    owner,
    contract,
    "reset_spent_total",
    {},
    "Reset blocked while escrow is pending",
  );

  await assertSnapshot(contract, {
    treasury: 3n * ONE_NEAR,
    locked: ONE_NEAR,
    spent: ONE_NEAR,
    budget: 2n * ONE_NEAR,
    available: 0n,
  }, "Rejected reset preserves accounting");

  section("10. Settle second payment and reset new budget period");

  await call(finance, contract, "release", {
    order_id: "admin-controls-order-2",
  });

  assert.deepEqual(await snapshot(contract), {
    treasury: 3n * ONE_NEAR,
    locked: 0n,
    spent: 2n * ONE_NEAR,
    budget: 2n * ONE_NEAR,
    available: 0n,
  });

  await call(owner, contract, "reset_spent_total");

  assert.deepEqual(await snapshot(contract), {
    treasury: 3n * ONE_NEAR,
    locked: 0n,
    spent: 0n,
    budget: 2n * ONE_NEAR,
    available: 2n * ONE_NEAR,
  });

  console.log("PASS: Reset succeeds after all escrows settle");
  console.log("PASS: Reset does not change treasury balance");
  console.log("PASS: Reset restores available budget for new period");

  section("11. Final assertions");

  assert.equal(
    (await contract.view("get_escrow", {
      order_id: "admin-controls-order-1",
    })).status,
    "Released",
  );

  assert.equal(
    (await contract.view("get_escrow", {
      order_id: "admin-controls-order-2",
    })).status,
    "Released",
  );

  console.log("PASS: Both orders remain Released");
  console.log("PASS: Admin controls integration test");
  console.log("LOCAL_SANDBOX_ONLY");
  console.log("NO_TESTNET_DEPLOYMENT");
  console.log("NO_WALLET_OR_PRIVATE_KEY_USED");
}

try {
  await main();
} catch (error) {
  console.error("ADMIN_CONTROLS_TEST_FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (worker) {
    await worker.tearDown();
    console.log("SANDBOX_STOPPED");
  }
}
