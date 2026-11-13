import { Worker } from "near-workspaces";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const YOCTO = 10n ** 24n;
const TERA_GAS = 10n ** 12n;

const WASM_PATH = path.resolve(
  "./target/near/agentbiz_treasury.wasm"
);

const EXPECTED_WASM_SHA256 =
  "39a6b0318ea2300cd18ccefeec7a7f163da47994cc21a50649c4595736f8085d";

let worker;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  console.log("========== 1. 验证 WASM ==========");

  const wasm = await readFile(WASM_PATH);
  const sha256 = createHash("sha256")
    .update(wasm)
    .digest("hex");

  console.log("WASM_PATH:", WASM_PATH);
  console.log("WASM_SIZE:", wasm.length);
  console.log("WASM_SHA256:", sha256);

  assert(
    sha256 === EXPECTED_WASM_SHA256,
    "WASM_SHA256_MISMATCH: refusing to deploy"
  );

  console.log("\n========== 2. 启动本地 Sandbox ==========");

  worker = await Worker.init({ network: "sandbox" });

  assert(
    worker.config.network === "sandbox",
    "NETWORK_NOT_SANDBOX"
  );

  const root = worker.rootAccount;

  console.log("NETWORK:", worker.config.network);
  console.log("ROOT:", root.accountId);

  console.log("\n========== 3. 创建临时 Owner ==========");

  const owner = await root.devCreateAccount({
    initialBalance: 100n * YOCTO,
  });

  console.log("OWNER:", owner.accountId);

  console.log("\n========== 4. 部署并初始化合约 ==========");

  const maxBudget = 100n * YOCTO;

  const contract = await root.devDeploy(wasm, {
    initialBalance: 30n * YOCTO,
    method: "new",
    args: {
      owner: owner.accountId,
      max_budget: maxBudget.toString(),
    },
    gas: 100n * TERA_GAS,
  });

  console.log("CONTRACT:", contract.accountId);

  console.log("\n========== 5. 查询初始化状态 ==========");

  const treasury = await contract.view("get_treasury_available");
  const locked = await contract.view("get_total_locked");
  const spent = await contract.view("get_spent_total");

  console.log("TREASURY_AVAILABLE:", treasury);
  console.log("TOTAL_LOCKED:", locked);
  console.log("SPENT_TOTAL:", spent);

  assert(BigInt(treasury) === 0n, "Unexpected initial treasury");
  assert(BigInt(locked) === 0n, "Unexpected initial locked amount");
  assert(BigInt(spent) === 0n, "Unexpected initial spent amount");

  const ownerBalance = await owner.balance();
  const contractBalance = await contract.balance();

  console.log("\n========== 6. 账户余额 ==========");
  console.log("OWNER_AVAILABLE:", ownerBalance.available);
  console.log("CONTRACT_AVAILABLE:", contractBalance.available);
  console.log("CONTRACT_TOTAL:", contractBalance.total);

  console.log("\nDEPLOY_SMOKE_SUCCESS");
  console.log("LOCAL_SANDBOX_ONLY");
  console.log("NO_TESTNET_DEPLOYMENT");
} catch (error) {
  console.error("\nDEPLOY_SMOKE_FAILED");
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (worker) {
    await worker.tearDown();
    console.log("\nSANDBOX_STOPPED");
  }
}
