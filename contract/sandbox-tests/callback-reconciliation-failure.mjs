import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "near-workspaces";

const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

const CONTRACT_INITIAL_BALANCE = 10n * ONE_NEAR;
const TREASURY_DEPOSIT = 10n * ONE_NEAR;
const MAX_BUDGET = 5n * ONE_NEAR;
const ORDER_AMOUNT = 1n * ONE_NEAR;
const AGENT_LIMIT = 5n * ONE_NEAR;

const ORDER_ID = "sandbox-reconciliation-failure-001";

const EXPECTED_FAULT_WASM_HASH =
  "c2605610bf00f19c9a43a4d84670d751c7f136e483b660c9806682de417a9ab6";

let worker;

function section(title) {
  console.log("\n========== " + title + " ==========");
}

function near(value) {
  return (Number(value) / Number(ONE_NEAR)).toFixed(6) + " NEAR";
}

function statusKind(status) {
  if (typeof status === "string") return status;
  if (status?.Failure !== undefined) return "Failure";
  if (status?.SuccessValue !== undefined) return "SuccessValue";
  if (status?.SuccessReceiptId !== undefined) return "SuccessReceiptId";
  return "UNKNOWN";
}

function inspectReceipts(result) {
  const rows = result.receipts_outcomes.map((receipt, index) => {
    const kind = statusKind(receipt.status);

    return {
      index,
      executor_id: receipt.outcome.executor_id,
      gas_burnt: receipt.gas_burnt,
      status: kind,
      raw_status: receipt.status,
      logs: receipt.logs,
    };
  });

  console.log(JSON.stringify(rows, null, 2));
  return rows;
}

function assertTxSuccess(result, label) {
  console.log(`${label}:`, result.summary());

  if (result.failed) {
    console.error(JSON.stringify(result.result, null, 2));
    throw new Error(`${label} failed`);
  }
}

async function call(account, contract, method, args = {}, options = {}) {
  const result = await account.callRaw(
    contract,
    method,
    args,
    {
      gas: 100n * TGAS,
      ...options,
    },
  );

  assertTxSuccess(result, method);
  return result;
}

async function getEscrow(contract) {
  const escrow = await contract.view("get_escrow", {
    order_id: ORDER_ID,
  });

  assert.ok(escrow, "Escrow not found");
  return escrow;
}

async function assertLedger(contract, expected) {
  const treasury = BigInt(
    await contract.view("get_treasury_available"),
  );
  const locked = BigInt(
    await contract.view("get_total_locked"),
  );
  const spent = BigInt(
    await contract.view("get_spent_total"),
  );

  console.log("Treasury:", near(treasury));
  console.log("Locked:", near(locked));
  console.log("Spent:", near(spent));

  assert.equal(treasury, expected.treasury);
  assert.equal(locked, expected.locked);
  assert.equal(spent, expected.spent);
}

async function main() {
  section("1. 启动本地 Sandbox");

  worker = await Worker.init({ network: "sandbox" });

  assert.equal(worker.config.network, "sandbox");

  const root = worker.rootAccount;

  console.log("Network:", worker.config.network);
  console.log("Root:", root.accountId);

  section("2. 创建独立角色账户");

  const owner = await root.createSubAccount("owner", {
    initialBalance: 20n * ONE_NEAR,
  });

  const supplier = await root.createSubAccount("supplier", {
    initialBalance: 10n * ONE_NEAR,
  });

  const agent = await root.createSubAccount("agent", {
    initialBalance: 10n * ONE_NEAR,
  });

  const finance1 = await root.createSubAccount("finance", {
    initialBalance: 10n * ONE_NEAR,
  });

  const finance2 = await root.createSubAccount("finance2", {
    initialBalance: 10n * ONE_NEAR,
  });

  console.log("Owner:", owner.accountId);
  console.log("Agent:", agent.accountId);
  console.log("Supplier:", supplier.accountId);
  console.log("Finance 1:", finance1.accountId);
  console.log("Finance 2:", finance2.accountId);

  assert.notEqual(finance1.accountId, finance2.accountId);

  section("3. 校验独立故障测试 WASM");

  const wasmPath = resolve(
    "fault-contract/target/near/agentbiz_treasury.wasm",
  );

  const wasm = await readFile(wasmPath);

  const wasmHash = createHash("sha256")
    .update(wasm)
    .digest("hex");

  console.log("WASM:", wasmPath);
  console.log("Bytes:", wasm.length);
  console.log("SHA256:", wasmHash);

  assert.equal(wasmHash, EXPECTED_FAULT_WASM_HASH);

  section("4. 部署本地测试合约");

  const contract = await root.devDeploy(wasm, {
    initialBalance: CONTRACT_INITIAL_BALANCE,
    method: "new",
    args: {
      owner: owner.accountId,
      max_budget: MAX_BUDGET.toString(),
    },
    gas: 100n * TGAS,
  });

  console.log("Contract:", contract.accountId);

  assert.equal(
    await contract.view("get_owner"),
    owner.accountId,
  );

  section("5. Owner 充值中央金库");

  await call(
    owner,
    contract,
    "deposit",
    {},
    { attachedDeposit: TREASURY_DEPOSIT },
  );

  section("6. 配置 Agent 和双财务审批人");

  await call(owner, contract, "set_agent", {
    agent: agent.accountId,
    enabled: true,
    per_order_limit: AGENT_LIMIT.toString(),
  });

  await call(owner, contract, "set_finance_approver", {
    account: finance1.accountId,
    enabled: true,
  });

  await call(owner, contract, "set_finance_approver", {
    account: finance2.accountId,
    enabled: true,
  });

  assert.equal(
    await contract.view("is_finance_approver", {
      account: finance1.accountId,
    }),
    true,
  );

  assert.equal(
    await contract.view("is_finance_approver", {
      account: finance2.accountId,
    }),
    true,
  );

  section("7. Agent 创建订单");

  await call(agent, contract, "create_escrow", {
    order_id: ORDER_ID,
    supplier: supplier.accountId,
    amount: ORDER_AMOUNT.toString(),
  });

  let escrow = await getEscrow(contract);

  assert.equal(escrow.status, "Open");
  assert.equal(escrow.supplier, supplier.accountId);

  await assertLedger(contract, {
    treasury: TREASURY_DEPOSIT - ORDER_AMOUNT,
    locked: ORDER_AMOUNT,
    spent: 0n,
  });

  section("8. Supplier 正常提交交付物");

  const deliveryHash = createHash("sha256")
    .update("AgentBiz failed supplier transfer delivery")
    .digest("hex");

  await call(supplier, contract, "submit_delivery", {
    order_id: ORDER_ID,
    sha256_hex: deliveryHash,
  });

  escrow = await getEscrow(contract);
  assert.equal(escrow.status, "Submitted");

  section("9. Finance 1 正常审批");

  await call(finance1, contract, "approve_delivery", {
    order_id: ORDER_ID,
    verified_sha256_hex: deliveryHash,
  });

  escrow = await getEscrow(contract);
  assert.equal(escrow.status, "Approved");

  section("10. 删除 Supplier 账户，制造真实转账失败条件");

  assert.equal(await supplier.exists(), true);

  const deleteResult = await supplier.delete(root.accountId);

  assertTxSuccess(deleteResult, "delete supplier account");

  assert.equal(
    await supplier.exists(),
    false,
    "Supplier account still exists; aborting before release",
  );

  console.log("Supplier account deleted:", supplier.accountId);
  console.log("Beneficiary:", root.accountId);
  console.log("PASS: Supplier no longer exists before release");

  section("11. 发起第一次付款尝试");

  const releaseResult = await finance1.callRaw(
    contract,
    "release",
    { order_id: ORDER_ID },
    { gas: 100n * TGAS },
  );

  console.log("Release summary:", releaseResult.summary());

  const receiptRows = inspectReceipts(releaseResult);

  const supplierTransferFailures = receiptRows.filter(
    (r) =>
      r.executor_id === supplier.accountId &&
      r.status === "Failure",
  );

  const supplierTransferSuccesses = receiptRows.filter(
    (r) =>
      r.executor_id === supplier.accountId &&
      (
        r.status === "SuccessValue" ||
        r.status === "SuccessReceiptId"
      ),
  );

  assert.ok(
    supplierTransferFailures.length >= 1,
    "Original supplier transfer receipt did not fail",
  );

  assert.equal(
    supplierTransferSuccesses.length,
    0,
    "Unsafe test condition: supplier transfer succeeded",
  );

  const callbackFailures = receiptRows.filter(
    (r) =>
      r.executor_id === contract.accountId &&
      r.status === "Failure",
  );

  assert.ok(
    callbackFailures.length >= 1,
    "Expected the test-only callback receipt to fail",
  );

  console.log("PASS: Original supplier transfer receipt failed");
  console.log("PASS: Callback receipt failed");

  section("12. 检查第一次付款失败后的状态");

  escrow = await getEscrow(contract);

  console.log("Escrow:", escrow.status);
  console.log("Attempt:", escrow.release_attempt);

  assert.equal(escrow.status, "Releasing");
  assert.equal(Number(escrow.release_attempt), 1);

  await assertLedger(contract, {
    treasury: TREASURY_DEPOSIT - ORDER_AMOUNT,
    locked: ORDER_AMOUNT,
    spent: 0n,
  });

  section("13. Finance 1 提交失败核对第一票");

  const evidenceHash = createHash("sha256")
    .update([
      "AgentBiz sandbox reconciliation evidence",
      ORDER_ID,
      "attempt-1",
      "supplier-account-deleted-before-transfer",
      "supplier-transfer-receipt-failure",
      "callback-receipt-failure",
    ].join("|"))
    .digest("hex");

  await call(finance1, contract, "reconcile_release", {
    order_id: ORDER_ID,
    attempt: 1,
    transfer_succeeded: false,
    evidence_hash: evidenceHash,
  });

  escrow = await getEscrow(contract);

  assert.equal(escrow.status, "Releasing");
  assert.equal(Number(escrow.release_attempt), 1);
  assert.equal(
    escrow.reconciliation_first_approver,
    finance1.accountId,
  );
  assert.equal(escrow.reconciliation_outcome, false);
  assert.equal(escrow.reconciliation_evidence_hash, evidenceHash);

  await assertLedger(contract, {
    treasury: TREASURY_DEPOSIT - ORDER_AMOUNT,
    locked: ORDER_AMOUNT,
    spent: 0n,
  });

  console.log("PASS: First vote stored; order remains Releasing");

  section("14. Finance 2 提交独立失败核对第二票");

  await call(finance2, contract, "reconcile_release", {
    order_id: ORDER_ID,
    attempt: 1,
    transfer_succeeded: false,
    evidence_hash: evidenceHash,
  });

  escrow = await getEscrow(contract);

  console.log("Escrow after reconciliation:", escrow.status);
  console.log("Attempt:", escrow.release_attempt);

  assert.equal(escrow.status, "Approved");
  assert.equal(Number(escrow.release_attempt), 1);

  assert.equal(escrow.reconciliation_first_approver, null);
  assert.equal(escrow.reconciliation_outcome, null);
  assert.equal(escrow.reconciliation_evidence_hash, null);

  await assertLedger(contract, {
    treasury: TREASURY_DEPOSIT - ORDER_AMOUNT,
    locked: ORDER_AMOUNT,
    spent: 0n,
  });

  section("15. 验证恢复 Approved 后允许再次发起付款");

  // Supplier remains deleted. This second attempt is expected to fail too.
  // It proves that the contract permits a new attempt and increments its
  // attempt counter; it does NOT claim that a second payment succeeded.
  const retryResult = await finance2.callRaw(
    contract,
    "release",
    { order_id: ORDER_ID },
    { gas: 100n * TGAS },
  );

  console.log("Retry summary:", retryResult.summary());

  const retryRows = inspectReceipts(retryResult);

  assert.ok(
    retryRows.some(
      (r) =>
        r.executor_id === supplier.accountId &&
        r.status === "Failure",
    ),
    "Second supplier transfer was not observed failing",
  );

  assert.equal(
    retryRows.filter(
      (r) =>
        r.executor_id === supplier.accountId &&
        (
          r.status === "SuccessValue" ||
          r.status === "SuccessReceiptId"
        ),
    ).length,
    0,
    "Unexpected successful supplier transfer",
  );

  escrow = await getEscrow(contract);

  assert.equal(escrow.status, "Releasing");
  assert.equal(Number(escrow.release_attempt), 2);

  assert.equal(escrow.reconciliation_first_approver, null);
  assert.equal(escrow.reconciliation_outcome, null);
  assert.equal(escrow.reconciliation_evidence_hash, null);

  await assertLedger(contract, {
    treasury: TREASURY_DEPOSIT - ORDER_AMOUNT,
    locked: ORDER_AMOUNT,
    spent: 0n,
  });

  section("16. 最终结论");

  console.log("PASS: Local Sandbox deployment");
  console.log("PASS: Supplier submitted delivery before deletion");
  console.log("PASS: Supplier account deleted before payment");
  console.log("PASS: Original supplier transfer receipt failed");
  console.log("PASS: Callback receipt failed");
  console.log("PASS: First false vote does not finalize");
  console.log("PASS: Second independent false vote restores Approved");
  console.log("PASS: Locked funds remain unchanged");
  console.log("PASS: Spent total remains zero");
  console.log("PASS: Reconciliation votes are cleared");
  console.log("PASS: New release attempt increments to 2");
  console.log("PASS: Retry does not falsely record a successful payment");

  console.log("LOCAL_SANDBOX_ONLY");
  console.log("NO_TESTNET_DEPLOYMENT");
}

try {
  await main();
} catch (error) {
  console.error("\nTEST FAILED");
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (worker) {
    await worker.tearDown();
    console.log("\nSANDBOX_STOPPED");
  }
}
