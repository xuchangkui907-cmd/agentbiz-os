import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { EXPLORER_URL } from "./config";

const NETWORK = "testnet" as const;
const CONTRACT_ID = "agentbiz.stormxu.testnet";

let connector: NearConnector | null = null;
let activeWallet: NearWalletBase | null = null;
let activeAccountId: string | null = null;

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
    activeAccountId = accounts[0].accountId;
    console.log("[AgentBiz Wallet] Connected:", {
      wallet: wallet.manifest.name,
      accountId: activeAccountId,
      network: NETWORK,
    });
  });

  instance.on("wallet:signOut", () => {
    activeWallet = null;
    activeAccountId = null;
    console.log("[AgentBiz Wallet] Disconnected");
  });

  connector = instance;
  return instance;
}

// Kept as a lightweight initialization API for compatibility.
export async function initWallet() {
  return getConnector();
}

// Explicitly opens the HOT wallet selector and connects the selected wallet.
export async function connectWallet() {
  const instance = await getConnector();

  console.log("[AgentBiz Wallet] Opening HOT wallet selector");
  const wallet = await instance.connect();

  const accounts = await wallet.getAccounts({ network: NETWORK });
  if (!accounts.length) {
    throw new Error("The selected wallet returned no NEAR accounts.");
  }

  activeWallet = wallet;
  activeAccountId = accounts[0].accountId;

  return {
    accountId: activeAccountId,
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
  activeAccountId = account.accountId;
  return activeAccountId;
}

export async function signAndSendTransaction(
  methodName: string,
  args: any,
  gas = "30000000000000",
  deposit = "0"
) {
  try {
    const instance = await getConnector();

    let wallet = activeWallet;
    let accountId = activeAccountId;

    if (!wallet || !accountId) {
      const connected = await instance.getConnectedWallet();
      wallet = connected.wallet;
      accountId = connected.accounts[0]?.accountId ?? null;
      activeWallet = wallet;
      activeAccountId = accountId;
    }

    if (!accountId) {
      return {
        success: false,
        error: "Please connect your Meteor wallet first.",
      };
    }

    console.log("[AgentBiz Wallet] Sending transaction:", {
      methodName,
      signerId: accountId,
      receiverId: CONTRACT_ID,
      network: NETWORK,
    });

    const result = await wallet.signAndSendTransaction({
      network: NETWORK,
      signerId: accountId,
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
