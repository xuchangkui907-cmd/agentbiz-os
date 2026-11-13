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

const ORDER_ID = "sandbox-callback-out-of-gas-001";
const ATTEMPT = 1;

const EXPECTED_FAULT_WASM_HASH =
  "b694ca882555b9f0bfb20a8ed05e449494637e4922f2a65eb4d83570401406c7";

let worker;

function section(title) {
  console.log("\n========== " + title + " ==========");
}

function near(value) {
  return (Number(value) / Number(ONE_NEAR)).toFixed(6) + " NEAR";
}

function assertTxSuccess(result, label) {
  console.log(`${label}:`, result.summary());

  if (result.failed) {
    console.error(
      "TRANSACTION_FAILURE:",
      JSON.stringify(result.result, null, 2),
    );
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
      gas_tgas: (
        Number(receipt.gas_burnt) / Number(TGAS)
      ).toFixed(6),
      status: kind,
      successful:
        kind === "SuccessValue" || kind === "SuccessReceiptId",
      failure: receipt.failureMessage ?? null,
      logs: receipt.logs,
    };
  });

  console.log(JSON.stringify(rows, null, 2));
  return rows;
}

async function getEscrow(contract) {
  const escrow = await contract.view("get_escrow", {
    order_id: ORDER_ID,
  });

  assert.ok(escrow, "Escrow not found");
  return escrow;
}

async function main() {
  section("1. 启动本地 Sandbox");

  worker = await Worker.init({ network: "sandbox" });

  assert.equal(worker.config.network, "sandbox");

  const root = worker.rootAccount;

  console.log("Network:", worker.config.network);
  console.log("Root:", root.accountId);

  section("2. 创建五个独立角色账户");

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
  assert.notEqual(agent.accountId, finance1.accountId);
  assert.notEqual(agent.accountId, finance2.accountId);

  section("3. 读取独立故障注入 WASM");

  const wasmPath = resolve(
    "oog-contract/target/near/agentbiz_treasury.wasm",
  );

  const wasm = await readFile(wasmPath);

  const wasmHash = createHash("sha256")
    .update(wasm)
    .digest("hex");

  console.log("WASM:", wasmPath);
  console.log("Bytes:", wasm.length);
  console.log("SHA256:", wasmHash);

  assert.equal(
    wasmHash,
    EXPECTED_FAULT_WASM_HASH,
    "Fault WASM hash mismatch",
  );

  section("4. 部署并初始化本地故障测试合约");

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

  assert.equal(
    BigInt(await contract.view("get_treasury_available")),
    TREASURY_DEPOSIT,
  );

  section("6. 配置 Agent 和两名独立财务审批人");

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

  section("7. Agent 创建订单并锁定资金");

  await call(agent, contract, "create_escrow", {
    order_id: ORDER_ID,
    supplier: supplier.accountId,
    amount: ORDER_AMOUNT.toString(),
  });

  let escrow = await getEscrow(contract);

  assert.equal(escrow.status, "Open");
  assert.equal(escrow.payer, agent.accountId);
  assert.equal(escrow.supplier, supplier.accountId);

  assert.equal(
    BigInt(await contract.view("get_total_locked")),
    ORDER_AMOUNT,
  );

  assert.equal(
    BigInt(await contract.view("get_treasury_available")),
    TREASURY_DEPOSIT - ORDER_AMOUNT,
  );

  section("8. Supplier 提交交付证明");

  const deliveryHash = createHash("sha256")
    .update("AgentBiz callback failure reconciliation delivery")
    .digest("hex");

  await call(supplier, contract, "submit_delivery", {
    order_id: ORDER_ID,
    sha256_hex: deliveryHash,
  });

  escrow = await getEscrow(contract);
  assert.equal(escrow.status, "Submitted");

  section("9. Finance 1 审批交付物");

  await call(finance1, contract, "approve_delivery", {
    order_id: ORDER_ID,
    verified_sha256_hex: deliveryHash,
  });

  escrow = await getEscrow(contract);
  assert.equal(escrow.status, "Approved");

  section("10. 记录供应商付款前余额");

  const supplierBefore = await supplier.availableBalance();

  console.log("Supplier before:", near(supplierBefore));

  section("11. 使用 1 Tgas 故障回调发起付款");

  // Deliberately do NOT call assertTxSuccess here.
  // The callback receipt is expected to fail, while the supplier
  // transfer receipt must succeed.
  const releaseResult = await finance1.callRaw(
    contract,
    "release",
    { order_id: ORDER_ID },
    { gas: 100n * TGAS },
  );

  console.log("Release transaction summary:", releaseResult.summary());

  const receiptRows = inspectReceipts(releaseResult);

  const supplierTransfer = receiptRows.find(
    (r) =>
      r.executor_id === supplier.accountId &&
      r.status === "SuccessValue",
  );

  assert.ok(
    supplierTransfer,
    "Supplier transfer receipt did not succeed",
  );

  const failedContractReceipts = receiptRows.filter(
    (r) =>
      r.executor_id === contract.accountId &&
      r.status === "Failure",
  );

  assert.equal(
    failedContractReceipts.length,
    1,
    "Expected exactly one failed contract receipt in the inspected receipt rows",
  );

  const oogPattern = /prepaid gas|out of gas|gas limit|gas burnt|gas burned|gas exceeded|exceeded.*gas|gas.*exceed/i;

  // near-workspaces may leave failureMessage null even though the raw
  // NEAR execution status contains the complete Runtime error.
  const rawCallbackFailures = releaseResult.receipts_outcomes.filter(
    (receipt) =>
      receipt.outcome.executor_id === contract.accountId &&
      statusKind(receipt.status) === "Failure",
  );

  assert.equal(
    rawCallbackFailures.length,
    1,
    "Expected exactly one failed contract callback receipt",
  );

  const rawCallbackStatus = JSON.stringify(rawCallbackFailures[0].status);
  console.log("Raw callback failure status:", rawCallbackStatus);

  assert.ok(
    oogPattern.test(rawCallbackStatus),
    "Callback did not fail with a recognizable OutOfGas Runtime error",
  );

  const oogLogs = rawCallbackFailures[0].logs ?? [];
  console.log("OOG callback logs:", oogLogs);

  assert.ok(
    oogLogs.some((line) => line.includes("OOG_TEST|CALLBACK_GAS_BURN|START")),
    "OOG callback did not emit the gas-burn START marker",
  );

  assert.ok(
    !oogLogs.some((line) => line.includes("OOG_TEST|CALLBACK_GAS_BURN|COMPLETED")),
    "Gas-burn loop completed; OOG was not demonstrated",
  );

  console.log("PASS: Callback Receipt failed specifically from gas exhaustion");

  section("12. 验证转账成功、回调失败后的实际状态");

  const supplierAfter = await supplier.availableBalance();
  const supplierReceived = supplierAfter - supplierBefore;

  console.log("Supplier after:", near(supplierAfter));
  console.log("Supplier received:", near(supplierReceived));

  assert.equal(
    supplierReceived,
    ORDER_AMOUNT,
    "Supplier did not receive exactly one payment",
  );

  escrow = await getEscrow(contract);

  const treasuryAfterRelease = BigInt(
    await contract.view("get_treasury_available"),
  );

  const lockedAfterRelease = BigInt(
    await contract.view("get_total_locked"),
  );

  const spentAfterRelease = BigInt(
    await contract.view("get_spent_total"),
  );

  console.log("Escrow status:", escrow.status);
  console.log("Release attempt:", escrow.release_attempt);
  console.log("Treasury:", near(treasuryAfterRelease));
  console.log("Locked:", near(lockedAfterRelease));
  console.log("Spent:", near(spentAfterRelease));

  assert.equal(escrow.status, "Releasing");
  assert.equal(Number(escrow.release_attempt), ATTEMPT);
  assert.equal(treasuryAfterRelease, TREASURY_DEPOSIT - ORDER_AMOUNT);
  assert.equal(lockedAfterRelease, ORDER_AMOUNT);
  assert.equal(spentAfterRelease, 0n);

  section("13. Owner 暂停合约，进入异常付款恢复模式");

  await call(owner, contract, "set_paused", { paused: true });

  assert.equal(await contract.view("get_paused"), true);
  assert.equal((await getEscrow(contract)).status, "Releasing");

  console.log("PASS: Contract paused while payment is Releasing");

  section("14. 暂停期间 Finance 1 提交第一份核对声明");

  const evidenceHash = createHash("sha256")
    .update(
      [
        "AgentBiz sandbox reconciliation evidence",
        ORDER_ID,
        String(ATTEMPT),
        "supplier-transfer-final-success",
        "callback-receipt-failure",
      ].join("|"),
    )
    .digest("hex");

  await call(finance1, contract, "reconcile_release", {
    order_id: ORDER_ID,
    attempt: ATTEMPT,
    transfer_succeeded: true,
    evidence_hash: evidenceHash,
  });

  escrow = await getEscrow(contract);

  assert.equal(escrow.status, "Releasing");
  assert.equal(
    escrow.reconciliation_first_approver,
    finance1.accountId,
  );
  assert.equal(escrow.reconciliation_outcome, true);
  assert.equal(escrow.reconciliation_evidence_hash, evidenceHash);

  assert.equal(
    BigInt(await contract.view("get_total_locked")),
    ORDER_AMOUNT,
  );

  assert.equal(
    BigInt(await contract.view("get_spent_total")),
    0n,
  );

  console.log("First vote stored; order remains Releasing");

  assert.equal(await contract.view("get_paused"), true);
  assert.equal((await getEscrow(contract)).status, "Releasing");

  console.log("PASS: First reconciliation vote works while paused");

  section("15. 暂停期间 Finance 2 独立提交第二份核对声明");

  await call(finance2, contract, "reconcile_release", {
    order_id: ORDER_ID,
    attempt: ATTEMPT,
    transfer_succeeded: true,
    evidence_hash: evidenceHash,
  });

  escrow = await getEscrow(contract);

  assert.equal(escrow.status, "Released");
  assert.equal(Number(escrow.release_attempt), ATTEMPT);

  assert.equal(escrow.reconciliation_first_approver, null);
  assert.equal(escrow.reconciliation_outcome, null);
  assert.equal(escrow.reconciliation_evidence_hash, null);

  assert.equal(await contract.view("get_paused"), true);

  console.log("PASS: Second reconciliation vote finalizes while paused");

  section("16. 验证最终资金账本");

  const treasuryFinal = BigInt(
    await contract.view("get_treasury_available"),
  );

  const lockedFinal = BigInt(
    await contract.view("get_total_locked"),
  );

  const spentFinal = BigInt(
    await contract.view("get_spent_total"),
  );

  const supplierFinal = await supplier.availableBalance();

  console.log("Escrow:", escrow.status);
  console.log("Treasury:", near(treasuryFinal));
  console.log("Locked:", near(lockedFinal));
  console.log("Spent:", near(spentFinal));
  console.log("Supplier total received:", near(supplierFinal - supplierBefore));

  assert.equal(treasuryFinal, TREASURY_DEPOSIT - ORDER_AMOUNT);
  assert.equal(lockedFinal, 0n);
  assert.equal(spentFinal, ORDER_AMOUNT);

  // No second release was initiated during reconciliation.
  assert.equal(
    supplierFinal - supplierBefore,
    ORDER_AMOUNT,
    "Duplicate payment detected",
  );

  section("16. 测试结论");

  console.log("PASS: Local Sandbox deployment");
  console.log("PASS: Agent creates centrally-funded escrow");
  console.log("PASS: Supplier transfer receipt succeeds");
  console.log("PASS: Callback Receipt fails from actual gas exhaustion");
  console.log("PASS: Escrow remains Releasing after callback failure");
  console.log("PASS: First finance vote does not finalize");
  console.log("PASS: Second independent finance vote finalizes while paused");
  console.log("PASS: Treasury and locked accounting are correct");
  console.log("PASS: Supplier receives exactly one payment");
  console.log("PASS: No duplicate payment during reconciliation");
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
