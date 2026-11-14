import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { EXPLORER_URL } from "./config";

const NETWORK = "testnet" as const;
const CONTRACT_ID = "agentbiz.stormxu.testnet";

let connector: NearConnector | null = null;
let activeWallet: NearWalletBase | null = null;
let activeAccountId: string | null = null;
let activeAccountIds: string[] = [];

async function getConnector(): Promise<NearConnector> {
  if (connector) return connector;

  const { NearConnector: Connector } = await import("@hot-labs/near-connect");

  const instance = new Connector({
    network: NETWORK,
    autoConnect: false,
    features: {
      testnet: true,
      signAndSendTransaction: true,
    },
  });

  await instance.whenManifestLoaded;

  instance.on("wallet:signIn", ({ wallet, accounts, success }) => {
    if (!success || !accounts.length) return;
    activeWallet = wallet;
    activeAccountIds = accounts.map((account) => account.accountId);
    activeAccountId = activeAccountIds[0] || null;
    console.log("[AgentBiz Wallet] Connected:", {
      wallet: wallet.manifest.name,
      accountId: activeAccountId,
      network: NETWORK,
    });
  });

  instance.on("wallet:signOut", () => {
    activeWallet = null;
    activeAccountId = null;
    activeAccountIds = [];
    console.log("[AgentBiz Wallet] Disconnected");
  });

  connector = instance;
  return instance;
}

// Kept as a lightweight initialization API for compatibility.
export async function initWallet() {
  return getConnector();
}

// Connect the wallet and ensure the selected business role is authorized.
// If the existing NEAR CLI connection belongs to another account, disconnect
// first so the CLI wallet can clear its cached account ID.
export async function connectWallet(expectedAccountId?: string) {
  const instance = await getConnector();

  if (expectedAccountId) {
    let existingWallet: NearWalletBase | null = null;
    let existingAccountIds: string[] = [];

    try {
      const connected = await instance.getConnectedWallet();
      existingWallet = connected.wallet;
      existingAccountIds = connected.accounts.map(
        (account) => account.accountId
      );
    } catch {
      // No persisted connector session. Fall back to this module's state.
      existingWallet = activeWallet;
      existingAccountIds = activeAccountIds;
    }

    if (
      existingWallet &&
      !existingAccountIds.includes(expectedAccountId)
    ) {
      console.log("[AgentBiz Wallet] Role account mismatch; disconnecting:", {
        connectedAccounts: existingAccountIds,
        expectedAccountId,
      });

      await instance.disconnect(existingWallet);

      // The connector also emits wallet:signOut; clear explicitly as well.
      activeWallet = null;
      activeAccountId = null;
      activeAccountIds = [];
    }
  }

  console.log("[AgentBiz Wallet] Opening HOT wallet selector", {
    expectedAccountId: expectedAccountId || null,
  });

  const wallet = await instance.connect();

  const accounts = await wallet.getAccounts({ network: NETWORK });
  if (!accounts.length) {
    throw new Error("The selected wallet returned no NEAR accounts.");
  }

  activeWallet = wallet;
  activeAccountIds = accounts.map((account) => account.accountId);
  activeAccountId = activeAccountIds[0] || null;

  console.log("[AgentBiz Wallet] Connected accounts:", {
    expectedAccountId: expectedAccountId || null,
    accountIds: activeAccountIds,
    expectedAccountAuthorized: expectedAccountId
      ? activeAccountIds.includes(expectedAccountId)
      : null,
  });

  return {
    accountId: activeAccountId,
    accountIds: activeAccountIds,
    walletName: wallet.manifest.name,
  };
}

export async function getAccountId(): Promise<string> {
  if (activeAccountId) return activeAccountId;

  const instance = await getConnector();
  const connected = await instance.getConnectedWallet();
  const account = connected.accounts[0];

  if (!account?.accountId) {
    throw new Error("No connected NEAR Testnet account. Please connect your wallet.");
  }

  activeWallet = connected.wallet;
  activeAccountIds = connected.accounts.map((item) => item.accountId);
  activeAccountId = account.accountId;
  return activeAccountId;
}

export async function signAndSendTransaction(
  methodName: string,
  args: any,
  gas = "30000000000000",
  deposit = "0",
  requestedSignerId?: string
) {
  try {
    const instance = await getConnector();

    let wallet = activeWallet;
    let accountId = activeAccountId;

    if (!wallet || !accountId) {
      const connected = await instance.getConnectedWallet();
      wallet = connected.wallet;
      activeAccountIds = connected.accounts.map((item) => item.accountId);
      accountId = activeAccountIds[0] ?? null;
      activeWallet = wallet;
      activeAccountId = accountId;
    }

    if (!accountId) {
      return {
        success: false,
        error: "Please connect your Meteor wallet first.",
      };
    }

    const signerId = requestedSignerId || accountId;
    if (!signerId || !activeAccountIds.includes(signerId)) {
      return {
        success: false,
        error: `当前钱包没有授权账户 ${signerId || "(unknown)"}。已连接账户：${activeAccountIds.join(", ") || "无"}。请连接包含该角色账户的钱包；为防止错误签名，交易已阻止。`,
      };
    }

    console.log("[AgentBiz Wallet] Sending transaction:", {
      methodName,
      signerId,
      receiverId: CONTRACT_ID,
      network: NETWORK,
    });

    const result = await wallet.signAndSendTransaction({
      network: NETWORK,
      signerId,
      receiverId: CONTRACT_ID,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName,
            args,
            gas,
            deposit,
          },
        },
      ],
    });

    console.log("[AgentBiz Wallet] Transaction confirmed:", {
      hash: result.transaction?.hash,
      methodName,
    });

    return { success: true, result };
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error("[AgentBiz Wallet] Transaction failed:", error);
    return { success: false, error: message };
  }
}

export function getExplorerLink(txHash: string) {
  return `${EXPLORER_URL}/txns/${txHash}`;
}
