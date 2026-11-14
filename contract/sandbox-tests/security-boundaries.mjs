import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "near-workspaces";

const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

const INITIAL_BALANCE = 10n * ONE_NEAR;
const OWNER_BALANCE = 20n * ONE_NEAR;
const TREASURY_DEPOSIT = 4n * ONE_NEAR;
const MAX_BUDGET = 5n * ONE_NEAR;
const AGENT_LIMIT = 5n * ONE_NEAR;
const ORDER_AMOUNT = ONE_NEAR;

const WASM_SHA256 =
  "39a6b0318ea2300cd18ccefeec7a7f163da47994cc21a50649c4595736f8085d";

let worker;

function section(title) {
  console.log("\n========== " + title + " ==========");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSuccess(result, label) {
  console.log("SUCCESS:", label, result.summary());

  if (result.failed) {
    console.error(JSON.stringify(result.result, null, 2));
    throw new Error("Unexpected transaction failure: " + label);
  }
}

async function call(account, contract, method, args = {}, options = {}) {
  const result = await account.callRaw(contract, method, args, {
    gas: 100n * TGAS,
    ...options,
  });

  assertSuccess(result, method);
  return result;
}

async function expectFailure(account, contract, method, args = {}, label = method) {
  const result = await account.callRaw(contract, method, args, {
    gas: 100n * TGAS,
  });

  console.log("EXPECTED FAILURE:", label);
  console.log("Summary:", result.summary());
  console.log("Failure:", result.failureMessage ?? "(no failure message)");

  assert.equal(
    result.failed,
    true,
    `Expected transaction to fail: ${label}`,
  );

  return result;
}

async function snapshot(contract) {
  return {
    treasury: BigInt(await contract.view("get_treasury_available")),
    locked: BigInt(await contract.view("get_total_locked")),
    spent: BigInt(await contract.view("get_spent_total")),
  };
}

async function assertSnapshot(contract, expected, label) {
  const actual = await snapshot(contract);

  assert.deepEqual(actual, expected, label);

  console.log("PASS:", label, {
    treasury: actual.treasury.toString(),
    locked: actual.locked.toString(),
    spent: actual.spent.toString(),
  });
}

async function escrowStatus(contract, orderId) {
  const escrow = await contract.view("get_escrow", {
    order_id: orderId,
  });

  assert.ok(escrow, `Escrow not found: ${orderId}`);
  return escrow.status;
}

async function createOrder(agent, contract, supplier, orderId, amount = ORDER_AMOUNT) {
  await call(agent, contract, "create_escrow", {
    order_id: orderId,
    supplier: supplier.accountId,
    amount: amount.toString(),
  });
}

async function submitDelivery(supplier, contract, orderId) {
  await call(supplier, contract, "submit_delivery", {
    order_id: orderId,
    sha256_hex: hash("AgentBiz security test delivery: " + orderId),
  });
}

async function main() {
  section("1. 启动本地 Sandbox");

  worker = await Worker.init({ network: "sandbox" });

  const root = worker.rootAccount;

  console.log("NETWORK: sandbox");
  console.log("ROOT:", root.accountId);

  section("2. 创建隔离测试账户");

  const owner = await root.createSubAccount("owner", {
    initialBalance: OWNER_BALANCE,
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

  const outsider = await root.createSubAccount("outsider", {
    initialBalance: 10n * ONE_NEAR,
  });

  console.log("OWNER:", owner.accountId);
  console.log("SUPPLIER:", supplier.accountId);
  console.log("AGENT:", agent.accountId);
  console.log("FINANCE:", finance.accountId);
  console.log("OUTSIDER:", outsider.accountId);

  section("3. 验证正式 WASM");

  const wasmPath = resolve("target/near/agentbiz_treasury.wasm");
  const wasm = await readFile(wasmPath);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");

  console.log("WASM:", wasmPath);
  console.log("WASM_BYTES:", wasm.length);
  console.log("WASM_SHA256:", wasmHash);

  assert.equal(wasmHash, WASM_SHA256, "Unexpected formal WASM");

  section("4. 本地部署和初始化");

  const contract = await root.devDeploy(wasm, {
    initialBalance: INITIAL_BALANCE,
    method: "new",
    args: {
      owner: owner.accountId,
      max_budget: MAX_BUDGET.toString(),
    },
    gas: 100n * TGAS,
  });

  console.log("CONTRACT:", contract.accountId);

  assert.equal(await contract.view("get_owner"), owner.accountId);

  section("5. 充值和角色配置");

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

  await assertSnapshot(
    contract,
    {
      treasury: TREASURY_DEPOSIT,
      locked: 0n,
      spent: 0n,
    },
    "Initial treasury accounting",
  );

  section("6. 角色冲突和管理权限");

  await expectFailure(
    owner,
    contract,
    "set_agent",
    {
      agent: finance.accountId,
      enabled: true,
      per_order_limit: AGENT_LIMIT.toString(),
    },
    "Finance approver cannot become agent",
  );

  await expectFailure(
    owner,
    contract,
    "set_finance_approver",
    {
      account: agent.accountId,
      enabled: true,
    },
    "Agent cannot become finance approver",
  );

  await expectFailure(
    outsider,
    contract,
    "set_agent",
    {
      agent: outsider.accountId,
      enabled: true,
      per_order_limit: AGENT_LIMIT.toString(),
    },
    "Non-owner cannot manage agents",
  );

  await expectFailure(
    outsider,
    contract,
    "create_escrow",
    {
      order_id: "unauthorized-create",
      supplier: supplier.accountId,
      amount: ORDER_AMOUNT.toString(),
    },
    "Unauthorized account cannot create order",
  );

  await assertSnapshot(
    contract,
    {
      treasury: TREASURY_DEPOSIT,
      locked: 0n,
      spent: 0n,
    },
    "Role failures do not change treasury",
  );

  section("7. 订单输入边界");

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "",
      supplier: supplier.accountId,
      amount: ORDER_AMOUNT.toString(),
    },
    "Empty order ID rejected",
  );

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "x".repeat(129),
      supplier: supplier.accountId,
      amount: ORDER_AMOUNT.toString(),
    },
    "129-byte order ID rejected",
  );

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "zero-amount",
      supplier: supplier.accountId,
      amount: "0",
    },
    "Zero amount rejected",
  );

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "over-agent-limit",
      supplier: supplier.accountId,
      amount: (6n * ONE_NEAR).toString(),
    },
    "Amount above agent limit rejected",
  );

  section("8. 建立三笔订单用于业务边界测试");

  const openId = "security-open-order";
  const submittedId = "security-submitted-order";
  const approvedId = "security-approved-order";

  await createOrder(agent, contract, supplier, openId);
  await createOrder(agent, contract, supplier, submittedId);
  await createOrder(agent, contract, supplier, approvedId);

  await submitDelivery(supplier, contract, submittedId);
  await submitDelivery(supplier, contract, approvedId);

  const approvedHash = hash(
    "AgentBiz security test delivery: " + approvedId,
  );

  await call(finance, contract, "approve_delivery", {
    order_id: approvedId,
    verified_sha256_hex: approvedHash,
  });

  assert.equal(await escrowStatus(contract, openId), "Open");
  assert.equal(await escrowStatus(contract, submittedId), "Submitted");
  assert.equal(await escrowStatus(contract, approvedId), "Approved");

  await assertSnapshot(
    contract,
    {
      treasury: ONE_NEAR,
      locked: 3n * ONE_NEAR,
      spent: 0n,
    },
    "Three orders lock exactly three NEAR",
  );

  section("9. 重复订单、预算上限和金库余额边界");

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: openId,
      supplier: supplier.accountId,
      amount: ORDER_AMOUNT.toString(),
    },
    "Duplicate order ID rejected",
  );

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "budget-overflow",
      supplier: supplier.accountId,
      amount: (3n * ONE_NEAR).toString(),
    },
    "Cumulative committed amount above budget rejected",
  );

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "treasury-insufficient",
      supplier: supplier.accountId,
      amount: (2n * ONE_NEAR).toString(),
    },
    "Insufficient treasury rejected",
  );

  await assertSnapshot(
    contract,
    {
      treasury: ONE_NEAR,
      locked: 3n * ONE_NEAR,
      spent: 0n,
    },
    "Order boundary failures preserve accounting",
  );

  section("10. Supplier 和 Finance 权限边界");

  await expectFailure(
    outsider,
    contract,
    "submit_delivery",
    {
      order_id: openId,
      sha256_hex: hash("unauthorized delivery"),
    },
    "Non-supplier cannot submit delivery",
  );

  await expectFailure(
    outsider,
    contract,
    "approve_delivery",
    {
      order_id: submittedId,
      verified_sha256_hex: hash(
        "AgentBiz security test delivery: " + submittedId,
      ),
    },
    "Unauthorized account cannot approve",
  );

  await expectFailure(
    agent,
    contract,
    "approve_delivery",
    {
      order_id: submittedId,
      verified_sha256_hex: hash(
        "AgentBiz security test delivery: " + submittedId,
      ),
    },
    "Agent cannot approve its own order",
  );

  await expectFailure(
    outsider,
    contract,
    "refund",
    {
      order_id: openId,
    },
    "Unauthorized account cannot refund",
  );

  await expectFailure(
    agent,
    contract,
    "release",
    {
      order_id: approvedId,
    },
    "Agent cannot release its own order",
  );

  await expectFailure(
    outsider,
    contract,
    "release",
    {
      order_id: approvedId,
    },
    "Unauthorized account cannot release",
  );

  assert.equal(await escrowStatus(contract, openId), "Open");
  assert.equal(await escrowStatus(contract, submittedId), "Submitted");
  assert.equal(await escrowStatus(contract, approvedId), "Approved");

  await assertSnapshot(
    contract,
    {
      treasury: ONE_NEAR,
      locked: 3n * ONE_NEAR,
      spent: 0n,
    },
    "Permission failures preserve all accounting",
  );

  section("11. 暂停状态下的交易限制");

  await call(owner, contract, "set_paused", {
    paused: true,
  });

  assert.equal(await contract.view("get_paused"), true);

  await expectFailure(
    agent,
    contract,
    "create_escrow",
    {
      order_id: "paused-create",
      supplier: supplier.accountId,
      amount: ORDER_AMOUNT.toString(),
    },
    "Create order rejected while paused",
  );

  await expectFailure(
    supplier,
    contract,
    "submit_delivery",
    {
      order_id: openId,
      sha256_hex: hash("paused submission"),
    },
    "Submit delivery rejected while paused",
  );

  await expectFailure(
    finance,
    contract,
    "approve_delivery",
    {
      order_id: submittedId,
      verified_sha256_hex: hash(
        "AgentBiz security test delivery: " + submittedId,
      ),
    },
    "Approve delivery rejected while paused",
  );

  await expectFailure(
    finance,
    contract,
    "release",
    {
      order_id: approvedId,
    },
    "Release rejected while paused",
  );

  assert.equal(await escrowStatus(contract, openId), "Open");
  assert.equal(await escrowStatus(contract, submittedId), "Submitted");
  assert.equal(await escrowStatus(contract, approvedId), "Approved");

  await assertSnapshot(
    contract,
    {
      treasury: ONE_NEAR,
      locked: 3n * ONE_NEAR,
      spent: 0n,
    },
    "Paused operation failures preserve accounting",
  );

  section("12. 暂停期间允许退款");

  await call(finance, contract, "refund", {
    order_id: openId,
  });

  assert.equal(await contract.view("get_paused"), true);
  assert.equal(await escrowStatus(contract, openId), "Refunded");

  await assertSnapshot(
    contract,
    {
      treasury: 2n * ONE_NEAR,
      locked: 2n * ONE_NEAR,
      spent: 0n,
    },
    "Refund while paused returns funds to internal treasury",
  );

  await expectFailure(
    finance,
    contract,
    "refund",
    {
      order_id: openId,
    },
    "Already-refunded order cannot be refunded twice",
  );

  await assertSnapshot(
    contract,
    {
      treasury: 2n * ONE_NEAR,
      locked: 2n * ONE_NEAR,
      spent: 0n,
    },
    "Duplicate refund does not change accounting",
  );

  section("13. 恢复业务并完成真实付款");

  await call(owner, contract, "set_paused", {
    paused: false,
  });

  assert.equal(await contract.view("get_paused"), false);

  const submittedHash = hash(
    "AgentBiz security test delivery: " + submittedId,
  );

  await call(finance, contract, "approve_delivery", {
    order_id: submittedId,
    verified_sha256_hex: submittedHash,
  });

  const supplierBefore = await supplier.availableBalance();

  await call(finance, contract, "release", {
    order_id: approvedId,
  });

  await call(finance, contract, "release", {
    order_id: submittedId,
  });

  assert.equal(await escrowStatus(contract, approvedId), "Released");
  assert.equal(await escrowStatus(contract, submittedId), "Released");

  const supplierAfter = await supplier.availableBalance();

  assert.equal(
    supplierAfter - supplierBefore,
    2n * ONE_NEAR,
    "Supplier must receive exactly two NEAR",
  );

  await assertSnapshot(
    contract,
    {
      treasury: 2n * ONE_NEAR,
      locked: 0n,
      spent: 2n * ONE_NEAR,
    },
    "Final treasury accounting after refunds and payments",
  );

  section("14. 测试总结");

  console.log("PASS: Formal WASM hash verified");
  console.log("PASS: Local Sandbox deployment");
  console.log("PASS: Role conflicts and owner-only management");
  console.log("PASS: Unauthorized order creation rejected");
  console.log("PASS: Order ID and amount boundaries");
  console.log("PASS: Duplicate order rejected");
  console.log("PASS: Cumulative budget limit enforced");
  console.log("PASS: Insufficient treasury rejected");
  console.log("PASS: Supplier and finance permissions enforced");
  console.log("PASS: Self-approval and self-release rejected");
  console.log("PASS: Pause blocks business operations");
  console.log("PASS: Refund remains available while paused");
  console.log("PASS: Duplicate refund rejected");
  console.log("PASS: Failed transactions preserve accounting");
  console.log("PASS: Normal payments work after unpause");
  console.log("PASS: Supplier receives exactly two NEAR");
  console.log("PASS: Final treasury invariants");

  console.log("\nLOCAL_SANDBOX_ONLY");
  console.log("NO_TESTNET_DEPLOYMENT");
  console.log("NO_WALLET_OR_PRIVATE_KEY_USED");
}

try {
  await main();
} catch (error) {
  console.error("\nSECURITY_BOUNDARIES_TEST_FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (worker) {
    await worker.tearDown();
    console.log("\nSANDBOX_STOPPED");
  }
}
