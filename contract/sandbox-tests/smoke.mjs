import { Worker } from "near-workspaces";

let worker;

try {
  // Explicitly use local Sandbox. No Testnet account or credentials.
  worker = await Worker.init({ network: "sandbox" });

  const root = worker.rootAccount;

  console.log("SANDBOX_STARTED");
  console.log("NETWORK: sandbox");
  console.log("ROOT_ACCOUNT:", root.accountId);
} catch (error) {
  console.error("SANDBOX_START_FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (worker) {
    await worker.tearDown();
    console.log("SANDBOX_STOPPED");
  }
}
