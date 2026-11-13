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
const ORDER_AMOUNT = ONE_NEAR;
const AGENT_LIMIT = 5n * ONE_NEAR;
const ORDER_COUNT = 5;
const ORDER_ID_BYTES = 128;

const EXPECTED_WASM_HASH =
  "39a6b0318ea2300cd18ccefeec7a7f163da47994cc21a50649c4595736f8085d";

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

function makeOrderId(index) {
  const prefix = `prod-stress-${String(index).padStart(3, "0")}-`;
  const id = prefix.padEnd(ORDER_ID_BYTES, "x");

  assert.equal(
    Buffer.byteLength(id, "utf8"),
    ORDER_ID_BYTES,
    "Order ID must be exactly 128 bytes",
  );

  return id;
}

function inspectReleaseReceipts(result, contractId, supplierId, orderId) {
  const rows = result.receipts_outcomes.map((receipt, index) => ({
    index,
    executor_id: receipt.outcome.executor_id,
    gas_burnt: String(receipt.gas_burnt),
    gas_tgas: (
      Number(receipt.gas_burnt) / Number(TGAS)
    ).toFixed(6),
    status: statusKind(receipt.status),
    raw_status: receipt.status,
    logs: receipt.logs ?? [],
  }));

  console.log(JSON.stringify(rows, null, 2));

  assert.ok(
    rows.every((row) =>
      row.status === "SuccessValue" ||
      row.status === "SuccessReceiptId"
    ),
    `${orderId}: at least one Receipt failed or has unknown status`,
  );

  const supplierReceipts = rows.filter(
    (row) =>
      row.executor_id === supplierId &&
      row.status === "SuccessValue",
  );

  assert.ok(
    supplierReceipts.length >= 1,
    `${orderId}: successful Supplier transfer Receipt missing`,
  );

  const callbackReceipts = rows.filter(
    (row) =>
      row.executor_id === contractId &&
      row.status === "SuccessValue" &&
      row.logs.some((line) =>
        line.includes(`AGENTBIZ|RELEASE_CONFIRMED|${orderId}`)
      ),
  );

  assert.equal(
    callbackReceipts.length,
    1,
    `${orderId}: expected exactly one successful release callback`,
  );

  const callbackGas = BigInt(callbackReceipts[0].gas_burnt);

  console.log(
    `CALLBACK_GAS: ${orderId}: ` +
    `${(Number(callbackGas) / Number(TGAS)).toFixed(6)} Tgas`,
  );

  return callbackGas;
}

async function assertLedger(contract, expected, label) {
  const treasury = BigInt(
    await contract.view("get_treasury_available"),
  );
  const locked = BigInt(
    await contract.view("get_total_locked"),
  );
  const spent = BigInt(
    await contract.view("get_spent_total"),
  );

  console.log(`${label} Treasury:`, near(treasury));
  console.log(`${label} Locked:`, near(locked));
  console.log(`${label} Spent:`, near(spent));

  assert.equal(treasury, expected.treasury);
  assert.equal(locked, expected.locked);
  assert.equal(spent, expected.spent);
}

async function main() {
  section("1. 启动独立本地 Sandbox");

  worker = await Worker.init({ network: "sandbox" });
  const root = worker.rootAccount;

  console.log("NETWORK: sandbox");
  console.log("ROOT:", root.accountId);

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

  const finance = await root.createSubAccount("finance", {
    initialBalance: 10n * ONE_NEAR,
  });

  console.log("Owner:", owner.accountId);
  console.log("Supplier:", supplier.accountId);
  console.log("Agent:", agent.accountId);
  console.log("Finance:", finance.accountId);

  section("3. 校验正式 WASM");

  const wasmPath = resolve("../target/near/agentbiz_treasury.wasm");
  const wasm = await readFile(wasmPath);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");

  console.log("WASM:", wasmPath);
  console.log("WASM bytes:", wasm.length);
  console.log("WASM SHA256:", wasmHash);

  assert.equal(
    wasmHash,
    EXPECTED_WASM_HASH,
    "Formal WASM hash mismatch",
  );

  section("4. 部署并初始化正式合约");

  const contract = await root.devDeploy(wasm, {
    initialBalance: CONTRACT_INITIAL_BALANCE,
    method: "new",
    args: {
      owner: owner.accountId,
      max_budget: MAX_BUDGET.toString(),
    },
    gas: 100n * TGAS,
  });

  console.log("CONTRACT:", contract.accountId);

  assert.equal(
    await contract.view("get_owner"),
    owner.accountId,
  );

  section("5. 充值金库并配置角色");

  await call(
    owner,
    contract,
    "deposit",
    {},
    { attachedDeposit: TREASURY_DEPOSIT },
  );

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

  section("6. 创建 5 笔最大长度订单 ID 的订单");

  const orders = Array.from(
    { length: ORDER_COUNT },
    (_, index) => ({
      id: makeOrderId(index + 1),
      index: index + 1,
    }),
  );

  for (const order of orders) {
    console.log(
      `ORDER ${order.index}: ${order.id} (${Buffer.byteLength(order.id)} bytes)`,
    );

    await call(agent, contract, "create_escrow", {
      order_id: order.id,
      supplier: supplier.accountId,
      amount: ORDER_AMOUNT.toString(),
    });
  }

  await assertLedger(
    contract,
    {
      treasury: TREASURY_DEPOSIT - BigInt(ORDER_COUNT) * ORDER_AMOUNT,
      locked: BigInt(ORDER_COUNT) * ORDER_AMOUNT,
      spent: 0n,
    },
    "After all orders created",
  );

  section("7. 提交全部交付证明并完成审批");

  for (const order of orders) {
    const deliveryHash = createHash("sha256")
      .update(`AgentBiz production callback stress delivery ${order.id}`)
      .digest("hex");

    await call(supplier, contract, "submit_delivery", {
      order_id: order.id,
      sha256_hex: deliveryHash,
    });

    await call(finance, contract, "approve_delivery", {
      order_id: order.id,
      verified_sha256_hex: deliveryHash,
    });

    const escrow = await contract.view("get_escrow", {
      order_id: order.id,
    });

    assert.equal(escrow.status, "Approved");
    assert.equal(escrow.amount, ORDER_AMOUNT.toString());
    assert.equal(escrow.submitted_hash, deliveryHash);
  }

  console.log("PASS: All five orders are Approved");
  console.log("PASS: All five orders remain in contract storage");

  section("8. 连续执行 5 笔正式付款并测量 Callback Gas");

  const supplierBefore = await supplier.availableBalance();
  const callbackGasMeasurements = [];

  for (const order of orders) {
    console.log(`\n--- RELEASE ORDER ${order.index} ---`);
    console.log("ORDER_ID:", order.id);

    const result = await call(
      finance,
      contract,
      "release",
      { order_id: order.id },
    );

    const callbackGas = inspectReleaseReceipts(
      result,
      contract.accountId,
      supplier.accountId,
      order.id,
    );

    callbackGasMeasurements.push({
      orderId: order.id,
      gas: callbackGas,
    });

    const escrow = await contract.view("get_escrow", {
      order_id: order.id,
    });

    assert.equal(escrow.status, "Released");
    assert.equal(Number(escrow.release_attempt), 1);

    console.log(`PASS: Order ${order.index} Released`);
  }

  section("9. 验证 Supplier 实际到账");

  const supplierAfter = await supplier.availableBalance();
  const supplierReceived = supplierAfter - supplierBefore;

  console.log("Supplier before:", near(supplierBefore));
  console.log("Supplier after:", near(supplierAfter));
  console.log("Supplier received:", near(supplierReceived));

  assert.equal(
    supplierReceived,
    BigInt(ORDER_COUNT) * ORDER_AMOUNT,
    "Supplier actual balance increase mismatch",
  );

  section("10. 汇总 Callback Gas");

  const gasValues = callbackGasMeasurements.map((item) => item.gas);
  const totalGas = gasValues.reduce((sum, value) => sum + value, 0n);
  const maxGas = gasValues.reduce(
    (maximum, value) => value > maximum ? value : maximum,
    0n,
  );
  const minGas = gasValues.reduce(
    (minimum, value) => value < minimum ? value : minimum,
    gasValues[0],
  );

  console.log("Callback count:", gasValues.length);
  console.log(
    "Total callback gas:",
    (Number(totalGas) / Number(TGAS)).toFixed(6),
    "Tgas",
  );
  console.log(
    "Average callback gas:",
    (Number(totalGas) / ORDER_COUNT / Number(TGAS)).toFixed(6),
    "Tgas",
  );
  console.log(
    "Maximum callback gas:",
    (Number(maxGas) / Number(TGAS)).toFixed(6),
    "Tgas",
  );
  console.log(
    "Minimum callback gas:",
    (Number(minGas) / Number(TGAS)).toFixed(6),
    "Tgas",
  );
  console.log(
    "Maximum callback gas utilization:",
    (Number(maxGas) / (15 * Number(TGAS)) * 100).toFixed(2),
    "%",
  );

  assert.equal(gasValues.length, ORDER_COUNT);
  assert.ok(maxGas < 15n * TGAS, "Callback exceeded configured 15 Tgas");

  section("11. 验证最终订单与账本");

  for (const order of orders) {
    const escrow = await contract.view("get_escrow", {
      order_id: order.id,
    });

    assert.equal(escrow.status, "Released");
    assert.equal(Number(escrow.release_attempt), 1);
  }

  await assertLedger(
    contract,
    {
      treasury: TREASURY_DEPOSIT - BigInt(ORDER_COUNT) * ORDER_AMOUNT,
      locked: 0n,
      spent: BigInt(ORDER_COUNT) * ORDER_AMOUNT,
    },
    "Final",
  );

  const availableBudget = BigInt(
    await contract.view("get_available_budget"),
  );

  assert.equal(availableBudget, 0n);

  section("12. 最终测试结果");

  console.log("PASS: Formal WASM hash verified");
  console.log("PASS: Five maximum-length order IDs");
  console.log("PASS: All orders created before release");
  console.log("PASS: All delivery proofs approved");
  console.log("PASS: All five supplier transfers succeeded");
  console.log("PASS: All five production callbacks succeeded");
  console.log("PASS: All five orders reached Released");
  console.log("PASS: Supplier received exactly 5 NEAR");
  console.log("PASS: All callback gas measurements below 15 Tgas");
  console.log("PASS: Treasury and accounting invariants");
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
