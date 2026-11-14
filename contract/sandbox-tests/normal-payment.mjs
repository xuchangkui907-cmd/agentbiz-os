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

const ORDER_ID = "sandbox-normal-payment-001";

let worker;

function logSection(title) {
  console.log("\n========== " + title + " ==========");
}

function near(value) {
  return (Number(value) / Number(ONE_NEAR)).toFixed(6) + " NEAR";
}

function assertTxSuccess(result, label) {
  console.log(`${label}:`, result.summary());

  if (result.failed) {
    console.error("TRANSACTION_FAILURE:", JSON.stringify(result.result, null, 2));
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

function printReceipts(result) {
  const receipts = result.receipts_outcomes;

  console.log("\nReceipt count:", receipts.length);

  const rows = receipts.map((receipt, index) => {
    const status = receipt.status;

    let status_kind = "UNKNOWN";

    if (typeof status === "string") {
      status_kind = status;
    } else if (status?.Failure !== undefined) {
      status_kind = "Failure";
    } else if (status?.SuccessValue !== undefined) {
      status_kind = "SuccessValue";
    } else if (status?.SuccessReceiptId !== undefined) {
      status_kind = "SuccessReceiptId";
    }

    return {
      index,
      executor_id: receipt.outcome.executor_id,
      gas_burnt: receipt.gas_burnt,
      gas_tgas: (Number(receipt.gas_burnt) / Number(TGAS)).toFixed(6),
      status_kind,
      successful: status_kind === "SuccessValue" ||
                  status_kind === "SuccessReceiptId",
      succeeded: receipt.succeeded,
      failed: receipt.isFailure,
      failure: receipt.failureMessage ?? null,
      logs: receipt.logs,
    };
  });

  console.log(JSON.stringify(rows, null, 2));

  return rows;
}

async function main() {
  logSection("1. 启动本地 Sandbox");

  worker = await Worker.init({ network: "sandbox" });

  const root = worker.rootAccount;

  console.log("Network: sandbox");
  console.log("Root:", root.accountId);

  logSection("2. 创建独立测试账户");

  const owner = await root.createSubAccount("owner", {
    initialBalance: 20n * ONE_NEAR,
  });

  const supplier = await root.createSubAccount("supplier", {
    initialBalance: 10n * ONE_NEAR,
  });

  const agent = await root.createSubAccount("agent", {
    initialBalance: 10n * ONE_NEAR,
  });

  const finance = await root.createSubAccount("finance", {
    initialBalance: 10n * ONE_NEAR,
  });

  console.log("Owner:", owner.accountId);
  console.log("Supplier:", supplier.accountId);
  console.log("Agent:", agent.accountId);
  console.log("Finance:", finance.accountId);

  logSection("3. 读取当前正式 WASM");

  const wasmPath = resolve("target/near/agentbiz_treasury.wasm");
  const wasm = await readFile(wasmPath);

  const localHash = createHash("sha256").update(wasm).digest("hex");

  console.log("WASM:", wasmPath);
  console.log("WASM bytes:", wasm.length);
  console.log("WASM SHA256:", localHash);

  assert.equal(
    localHash,
    "39a6b0318ea2300cd18ccefeec7a7f163da47994cc21a50649c4595736f8085d",
    "WASM hash differs from the reviewed build",
  );

  logSection("4. 部署并初始化合约");

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
    "Contract owner mismatch",
  );

  console.log("Contract initialized successfully");

  logSection("5. Owner 充值金库");

  const depositResult = await call(
    owner,
    contract,
    "deposit",
    {},
    { attachedDeposit: TREASURY_DEPOSIT },
  );

  console.log("Deposit logs:", depositResult.logs);

  const treasuryAfterDeposit =
    BigInt(await contract.view("get_treasury_available"));

  console.log("Treasury available:", near(treasuryAfterDeposit));

  assert.equal(
    treasuryAfterDeposit,
    TREASURY_DEPOSIT,
    "Treasury deposit amount mismatch",
  );

  logSection("6. 配置 Agent 和 Finance Approver");

  await call(owner, contract, "set_agent", {
    agent: agent.accountId,
    enabled: true,
    per_order_limit: AGENT_LIMIT.toString(),
  });

  await call(owner, contract, "set_finance_approver", {
    account: finance.accountId,
    enabled: true,
  });

  assert.equal(
    await contract.view("is_finance_approver", {
      account: finance.accountId,
    }),
    true,
  );

  console.log("Agent and finance roles configured");

  logSection("7. Agent 创建订单");

  await call(agent, contract, "create_escrow", {
    order_id: ORDER_ID,
    supplier: supplier.accountId,
    amount: ORDER_AMOUNT.toString(),
  });

  let escrow = await contract.view("get_escrow", {
    order_id: ORDER_ID,
  });

  assert.equal(escrow.status, "Open");
  assert.equal(escrow.payer, agent.accountId);
  assert.equal(escrow.supplier, supplier.accountId);
  assert.equal(escrow.amount, ORDER_AMOUNT.toString());

  assert.equal(
    BigInt(await contract.view("get_total_locked")),
    ORDER_AMOUNT,
  );

  assert.equal(
    BigInt(await contract.view("get_treasury_available")),
    TREASURY_DEPOSIT - ORDER_AMOUNT,
  );

  console.log("Order created and treasury funds locked");

  logSection("8. Supplier 提交交付证明");

  const deliveryHash = createHash("sha256")
    .update("AgentBiz Sandbox normal payment delivery")
    .digest("hex");

  await call(supplier, contract, "submit_delivery", {
    order_id: ORDER_ID,
    sha256_hex: deliveryHash,
  });

  escrow = await contract.view("get_escrow", {
    order_id: ORDER_ID,
  });

  assert.equal(escrow.status, "Submitted");
  assert.equal(escrow.submitted_hash, deliveryHash);

  console.log("Delivery SHA256:", deliveryHash);

  logSection("9. Finance Approver 审批");

  await call(finance, contract, "approve_delivery", {
    order_id: ORDER_ID,
    verified_sha256_hex: deliveryHash,
  });

  escrow = await contract.view("get_escrow", {
    order_id: ORDER_ID,
  });

  assert.equal(escrow.status, "Approved");

  console.log("Delivery approved");

  logSection("10. 记录 Supplier 付款前余额");

  const supplierBefore = await supplier.availableBalance();

  console.log("Supplier available before:", near(supplierBefore));

  logSection("11. 发起真实 NEAR 转账");

  const releaseResult = await call(
    finance,
    contract,
    "release",
    {
      order_id: ORDER_ID,
    },
  );

  logSection("12. 分析完整交易 Receipt");

  const receiptRows = printReceipts(releaseResult);

  assert.ok(
    receiptRows.some(
      (r) => r.executor_id === supplier.accountId && r.successful,
    ),
    "Successful supplier transfer receipt not found",
  );

  assert.ok(
    receiptRows.some(
      (r) =>
        r.executor_id === contract.accountId &&
        r.successful &&
        r.logs.some((log) =>
          log.includes("AGENTBIZ|RELEASE_CONFIRMED|" + ORDER_ID)
        ),
    ),
    "Successful contract callback receipt with RELEASE_CONFIRMED log not found",
  );

  assert.ok(
    receiptRows.every((r) => r.successful),
    "At least one receipt failed or has an unrecognized execution status",
  );

  logSection("13. 验证 Supplier 实际到账");

  const supplierAfter = await supplier.availableBalance();
  const supplierReceived = supplierAfter - supplierBefore;

  console.log("Supplier available after:", near(supplierAfter));
  console.log("Supplier received:", near(supplierReceived));

  assert.equal(
    supplierReceived,
    ORDER_AMOUNT,
    "Supplier balance increase differs from transfer amount",
  );

  logSection("14. 验证最终订单状态和金库账本");

  escrow = await contract.view("get_escrow", {
    order_id: ORDER_ID,
  });

  const treasuryFinal =
    BigInt(await contract.view("get_treasury_available"));

  const lockedFinal =
    BigInt(await contract.view("get_total_locked"));

  const spentFinal =
    BigInt(await contract.view("get_spent_total"));

  console.log("Escrow status:", escrow.status);
  console.log("Release attempt:", escrow.release_attempt);
  console.log("Treasury available:", near(treasuryFinal));
  console.log("Total locked:", near(lockedFinal));
  console.log("Spent total:", near(spentFinal));

  assert.equal(escrow.status, "Released");
  assert.equal(Number(escrow.release_attempt), 1);
  assert.equal(treasuryFinal, TREASURY_DEPOSIT - ORDER_AMOUNT);
  assert.equal(lockedFinal, 0n);
  assert.equal(spentFinal, ORDER_AMOUNT);

  logSection("15. 测试结果");

  console.log("PASS: Sandbox normal payment integration test");
  console.log("PASS: Owner treasury deposit");
  console.log("PASS: Agent order creation");
  console.log("PASS: Supplier delivery submission");
  console.log("PASS: Finance approval");
  console.log("PASS: Supplier transfer receipt");
  console.log("PASS: Contract callback receipt");
  console.log("PASS: Supplier actual balance increase");
  console.log("PASS: Escrow and treasury accounting");
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
