import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Wallet,
  TrendingUp,
  Users,
  Package,
  ShieldCheck,
  FileText,
  Plus,
} from "lucide-react";
import {
  getAgentBizDashboard,
  refreshAgentBizChainData,
  createAgentBizOrder,
  updateAgentBizOrder,
} from "@/lib/agentbiz/server";
import { CONTRACT_ID, knownRoles, RPC_URL } from "@/lib/near/config";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type Order = {
  id: string;
  agent_id: string;
  amount_near: number | null;
  supplier_id: string;
  status: string;
  delivery_hash?: string;
  created_at: string;
  chainFound?: boolean;
  chainError?: string | null;
};

type Agent = {
  account_id: string;
  name: string;
  role: string;
  max_single_order_near: number;
  is_active: boolean;
};

type DashboardData = {
  treasuryNear: number | null;
  lockedNear: number | null;
  spentNear: number | null;
  activeOrders: number;
  orders: Order[];
  agents: Agent[];
  chainAvailable: boolean;
  chainError: string | null;
  chainOwner: string | null;
  chainPaused: boolean | null;
  lastSyncedAt: string;
  orderIndexSource: string;
  chainSyncStatus: "never" | "syncing" | "synced" | "stale" | "error";
};

type DeliverySubmission = {
  orderId: string;
  description: string;
  hash: string;
};

type ApprovalSubmission = {
  orderId: string;
  notes: string;
};

type AgentChainInfo = {
  limit: string;
  accountExists: boolean | null;
  balance: string | null;
  error: string | null;
};

type Notice = {
  type: "success" | "error" | "info" | "warning";
  message: string;
};

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  "stormxu.testnet": "Owner (stormxu.testnet)",
  "agent.stormxu.testnet": "Agent A (Market Research)",
  "agent2.stormxu.testnet": "Agent B (Development)",
  "agent3.stormxu.testnet": "Agent C (Marketing)",
  "finance.stormxu.testnet": "Finance Approver",
  "supplier.stormxu.testnet": "Supplier",
};

const ROLE_OPTIONS = Object.entries(ROLE_LABELS);

const INITIAL_DASHBOARD: DashboardData = {
  treasuryNear: null,
  lockedNear: null,
  spentNear: null,
  activeOrders: 0,
  orders: [],
  agents: [],
  chainAvailable: false,
  chainError: null,
  chainOwner: null,
  chainPaused: null,
  lastSyncedAt: "",
  orderIndexSource: "database",
  chainSyncStatus: "never",
};

// ─────────────────────────────────────────────
// Browser-side NEAR RPC (rate-limited + retry)
// ─────────────────────────────────────────────

let browserRpcQueue: Promise<void> = Promise.resolve();
let browserLastRpcAt = 0;

async function browserRpcRequest(body: Record<string, unknown>) {
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const waitMs = Math.max(0, 350 - (Date.now() - browserLastRpcAt));
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      browserLastRpcAt = Date.now();

      let response: Response;
      try {
        response = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw error;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After") || 0);
        await new Promise((r) =>
          setTimeout(r, retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 1000 * (attempt + 1))
        );
        continue;
      }

      const data = await response.json();

      if (!response.ok || data.error) {
        const message =
          data.error?.cause?.info ||
          data.error?.message ||
          `NEAR RPC HTTP ${response.status}`;

        if (/429|rate.?limit|too many requests/i.test(message) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(message);
      }
      return data;
    }
    throw new Error("NEAR RPC 重试次数已用尽");
  };

  const task = browserRpcQueue.then(run, run);
  browserRpcQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

async function nearView(methodName: string, args: Record<string, unknown> = {}) {
  const encodedArgs = btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args)))
  );
  const data = await browserRpcRequest({
    jsonrpc: "2.0",
    id: "agentbiz-view",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: CONTRACT_ID,
      method_name: methodName,
      args_base64: encodedArgs,
    },
  });
  const bytes = new Uint8Array(data.result.result);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function nearAccount(accountId: string) {
  const data = await browserRpcRequest({
    jsonrpc: "2.0",
    id: "agentbiz-account",
    method: "query",
    params: {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    },
  });
  if (data.error) {
    const message = data.error.cause?.info || data.error.message || "Account query failed";
    if (/does not exist|unknown account|account.*not found/i.test(message)) {
      return null;
    }
    throw new Error(message);
  }
  return data.result;
}

function formatYocto(value: string): string {
  return (Number(value) / 1e24).toFixed(4);
}

function nearToYocto(value: string): string {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(normalized)) {
    throw new Error("请输入有效的 NEAR 数量，最多 24 位小数");
  }
  const [whole, fraction = ""] = normalized.split(".");
  return (
    BigInt(whole) * 10n ** 24n +
    BigInt((fraction + "0".repeat(24)).slice(0, 24))
  ).toString();
}

// ─────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  // Core data
  const [dashboard, setDashboard] = useState<DashboardData>(INITIAL_DASHBOARD);
  const [loading, setLoading] = useState(true);

  // UI
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "agents" | "orders" | "supplier" | "finance"
  >("dashboard");
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [currentAccount, setCurrentAccount] = useState("stormxu.testnet");
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Forms
  const [newOrder, setNewOrder] = useState({
    agent: "agent.stormxu.testnet",
    amount: "0.15",
    description: "",
  });
  const [delivery, setDelivery] = useState<DeliverySubmission>({
    orderId: "",
    description: "",
    hash: "",
  });
  const [approval, setApproval] = useState<ApprovalSubmission>({
    orderId: "",
    notes: "",
  });

  // Agent management
  const [chainOwner, setChainOwner] = useState<string | null>(null);
  const [agentChainState, setAgentChainState] = useState<Record<string, AgentChainInfo>>({});
  const [agentLimitInputs, setAgentLimitInputs] = useState<Record<string, string>>({});
  const [agentChainLoading, setAgentChainLoading] = useState(false);
  const [agentAction, setAgentAction] = useState<string | null>(null);

  const agentRefreshInFlight = useRef(false);
  const agentRefreshPending = useRef(false);
  const refreshAgentChainStateRef = useRef<(() => Promise<void>) | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Notice helper ───────────────────────────
  const showNotice = useCallback((type: Notice["type"], message: string, duration = 6000) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ type, message });
    noticeTimer.current = setTimeout(() => setNotice(null), duration);
  }, []);

  // ─── Dashboard load ──────────────────────────
  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAgentBizDashboard();
      setDashboard({
        ...data,
        chainSyncStatus: "syncing",
      });
      setLoading(false);

      // Background chain refresh
      void refreshAgentBizChainData()
        .then((result: any) => {
          if (result?.success && result.dashboard) {
            setDashboard((prev) => ({
              ...prev,
              ...result.dashboard,
              agents: prev.agents,
            }));
          } else {
            setDashboard((prev) => ({
              ...prev,
              chainSyncStatus: "error",
              chainError: result?.error || "Chain refresh failed",
            }));
          }
        })
        .catch((error: any) => {
          setDashboard((prev) => ({
            ...prev,
            chainSyncStatus: "error",
            chainError: error?.message || String(error),
          }));
        });
    } catch (e) {
      console.error("Dashboard load failed:", e);
      setDashboard({
        ...INITIAL_DASHBOARD,
        chainError: e instanceof Error ? e.message : String(e),
        chainSyncStatus: "error",
      });
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // ─── Agent chain state ───────────────────────
  const refreshAgentChainState = useCallback(async () => {
    // Contract owner is independent of the database Agent registry.
    // Always read the owner even when the Agent list is empty.
    if (agentRefreshInFlight.current) {
      agentRefreshPending.current = true;
      return;
    }
    agentRefreshInFlight.current = true;
    setAgentChainLoading(true);

    try {
      const owner = await nearView("get_owner");
      setChainOwner(String(owner));

      const nextState: Record<string, AgentChainInfo> = { ...agentChainState };

      for (const agent of dashboard.agents) {
        const previous = nextState[agent.account_id];
        try {
          const rawLimit = await nearView("get_agent_limit", {
            agent: agent.account_id,
          });
          const account = await nearAccount(agent.account_id);

          nextState[agent.account_id] = {
            limit: String(rawLimit),
            accountExists: account !== null,
            balance: account ? formatYocto(String(account.amount)) : null,
            error: null,
          };
        } catch (error: any) {
          nextState[agent.account_id] = {
            limit: previous?.limit ?? "",
            accountExists: previous?.accountExists ?? null,
            balance: previous?.balance ?? null,
            error: error?.message || "链上查询失败",
          };
        }
      }

      setAgentChainState(nextState);

      const failed = Object.values(nextState).filter((item) => item.error).length;
      if (failed > 0) {
        showNotice(
          "warning",
          `${failed} 个 Agent 的链上数据暂时无法刷新，已保留上次成功状态。`
        );
      }
    } catch (error: any) {
      showNotice("error", `链上数据读取失败：${error?.message || "未知错误"}`);
    } finally {
      setAgentChainLoading(false);
      agentRefreshInFlight.current = false;

      if (agentRefreshPending.current) {
        agentRefreshPending.current = false;
        Promise.resolve().then(() => refreshAgentChainStateRef.current?.());
      }
    }
  }, [dashboard.agents, agentChainState, showNotice]);

  refreshAgentChainStateRef.current = refreshAgentChainState;

  useEffect(() => {
    if (activeTab === "agents") {
      refreshAgentChainState();
    }
  }, [activeTab, dashboard.agents]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Agent authorize / revoke ────────────────
  async function changeAgentAuthorization(agentId: string, enabled: boolean) {
    if (!connectedWallet) {
      showNotice("warning", "请先连接 NEAR Wallet。");
      return;
    }
    if (!chainOwner || connectedWallet !== chainOwner) {
      showNotice(
        "warning",
        `只有合约 Owner (${chainOwner || "尚未读取"}) 可以管理 Agent。`
      );
      return;
    }
    if (agentId === chainOwner || agentId === knownRoles.finance) {
      showNotice("warning", "Owner 和 Finance Approver 不能同时拥有 Agent 权限。");
      return;
    }

    const currentLimit = agentLimitInputs[agentId] || "0.1";
    let yocto = "0";
    if (enabled) {
      try {
        yocto = nearToYocto(currentLimit);
        if (BigInt(yocto) <= 0n) throw new Error("单笔限额必须大于 0");
      } catch (error: any) {
        showNotice("error", error?.message || "单笔限额无效");
        return;
      }
    }

    const actionKey = `${enabled ? "authorize" : "revoke"}:${agentId}`;
    setAgentAction(actionKey);

    try {
      const walletModule = await import("@/lib/near/wallet");
      const result = await walletModule.signAndSendTransaction(
        "set_agent",
        {
          agent: agentId,
          enabled,
          per_order_limit: yocto,
        },
        "100000000000000",
        "0"
      );

      if (!result.success) {
        throw new Error(result.error || "交易未成功");
      }

      showNotice(
        "info",
        `${enabled ? "授权" : "撤销"}交易已提交，正在刷新链上状态…`
      );
      await refreshAgentChainState();
      showNotice(
        "success",
        `${agentId}：${enabled ? "授权" : "撤销"}操作已提交，请核对最终链上状态。`
      );
    } catch (error: any) {
      showNotice("error", `操作失败：${error?.message || "交易失败"}`);
    } finally {
      setAgentAction(null);
    }
  }

  // ─── Create Order ────────────────────────────
  async function createNewOrder() {
    if (!newOrder.amount.trim() || !newOrder.description.trim()) {
      showNotice("warning", "请填写金额与描述");
      return;
    }

    const amountText = newOrder.amount.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,24})?$/.test(amountText)) {
      showNotice("error", "请输入有效的 NEAR 金额（最多 24 位小数）");
      return;
    }

    const [wholePart, fractionPart = ""] = amountText.split(".");
    const amountYocto = (
      BigInt(wholePart) * 10n ** 24n +
      BigInt(fractionPart.padEnd(24, "0") || "0")
    ).toString();

    if (BigInt(amountYocto) <= 0n) {
      showNotice("error", "金额必须大于 0");
      return;
    }

    setSubmitting(true);
    try {
      const orderId = `AGENTBIZ-AI-${crypto.randomUUID()}`;

      const wallet = await import("@/lib/near/wallet");
      const result = await wallet.signAndSendTransaction(
        "create_escrow",
        {
          order_id: orderId,
          supplier: "supplier.stormxu.testnet",
          amount: amountYocto,
        },
        "30000000000000",
        "0"
      );

      if (!result.success) {
        showNotice("error", `交易失败或用户取消：${result.error || "未知错误"}`);
        return;
      }

      const txHash =
        result.result?.transaction?.hash ||
        result.result?.transaction_outcome?.id ||
        "";

      try {
        await createAgentBizOrder({
          data: {
            id: orderId,
            agent_id: newOrder.agent,
            amount_near: Number(amountText),
            supplier_id: "supplier.stormxu.testnet",
          },
        });

        await loadDashboard();
        setNewOrder({
          agent: "agent.stormxu.testnet",
          amount: "0.15",
          description: "",
        });

        showNotice(
          "success",
          `订单创建成功\nOrder ID: ${orderId}\nTx: ${txHash || "confirmed"}`
        );
      } catch (dbError: any) {
        showNotice(
          "error",
          `重要：链上交易已成功，但数据库索引失败。\nOrder ID: ${orderId}\nTx: ${txHash || "unknown"}\n错误：${dbError?.message || String(dbError)}\n请勿重复创建，修复数据库后用同一 Order ID 重新索引。`,
          12000
        );
      }
    } catch (e: any) {
      showNotice("error", e.message || "创建订单失败");
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Supplier: Submit Delivery ───────────────
  async function submitDelivery() {
    if (!delivery.orderId || !delivery.hash) {
      showNotice("warning", "请填写 Order ID 和 SHA-256 Hash");
      return;
    }

    setSubmitting(true);
    try {
      const walletModule = await import("@/lib/near/wallet");
      const result = await walletModule.signAndSendTransaction("submit_delivery", {
        order_id: delivery.orderId,
        sha256_hex: delivery.hash,
      });

      if (!result.success) {
        showNotice("error", `交易失败：${result.error || "未知错误"}`);
        return;
      }

      await updateAgentBizOrder({
        data: {
          id: delivery.orderId,
          updates: { status: "Submitted", delivery_hash: delivery.hash },
        },
      });
      await loadDashboard();
      setDelivery({ orderId: "", description: "", hash: "" });
      showNotice(
        "success",
        `交付已提交\nTx: ${result.result?.transaction?.hash || "success"}`
      );
    } catch (e: any) {
      showNotice("error", e.message || "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Finance: Approve ────────────────────────
  async function approveDelivery() {
    if (!approval.orderId) {
      showNotice("warning", "请输入 Order ID");
      return;
    }

    setSubmitting(true);
    try {
      const walletModule = await import("@/lib/near/wallet");
      // 注意：生产环境应使用真实的 delivery hash，这里保持原逻辑兼容
      const hashToUse =
        delivery.hash ||
        "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3";

      const result = await walletModule.signAndSendTransaction("approve_delivery", {
        order_id: approval.orderId,
        verified_sha256_hex: hashToUse,
      });

      if (!result.success) {
        showNotice("error", `审批失败：${result.error || "未知错误"}`);
        return;
      }

      await updateAgentBizOrder({
        data: {
          id: approval.orderId,
          updates: { status: "Approved" },
        },
      });
      await loadDashboard();
      showNotice(
        "success",
        `已审批\nTx: ${result.result?.transaction?.hash || "success"}`
      );
    } catch (e: any) {
      showNotice("error", e.message || "审批失败");
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Finance: Release ────────────────────────
  async function releaseFunds() {
    if (!approval.orderId) {
      showNotice("warning", "请输入 Order ID");
      return;
    }

    setSubmitting(true);
    try {
      const walletModule = await import("@/lib/near/wallet");
      const result = await walletModule.signAndSendTransaction("release", {
        order_id: approval.orderId,
      });

      if (!result.success) {
        showNotice("error", `释放失败：${result.error || "未知错误"}`);
        return;
      }

      await updateAgentBizOrder({
        data: {
          id: approval.orderId,
          updates: { status: "Released" },
        },
      });
      await loadDashboard();
      showNotice(
        "success",
        `资金已释放给供应商\nTx: ${result.result?.transaction?.hash || "success"}`
      );
    } catch (e: any) {
      showNotice("error", e.message || "释放失败");
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Wallet Connect ──────────────────────────
  async function handleConnectWallet() {
    try {
      const walletModule = await import("@/lib/near/wallet");
      const connected = await walletModule.connectWallet();
      setCurrentAccount(connected.accountId || currentAccount);
      setConnectedWallet(connected.accountId || null);
      showNotice(
        "success",
        `已连接 ${connected.walletName}: ${connected.accountId}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice("error", `钱包连接失败：${message}`);
    }
  }

  // ─── Generate SHA-256 ────────────────────────
  async function generateSha256() {
    if (!delivery.description) {
      showNotice("warning", "请先输入交付描述");
      return;
    }
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(delivery.description)
    );
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    setDelivery((prev) => ({ ...prev, hash: hashHex }));
  }

  // ─── Status text helper ──────────────────────
  function getSyncStatusText() {
    if (loading) return "Loading application data...";
    switch (dashboard.chainSyncStatus) {
      case "syncing":
        return dashboard.lastSyncedAt
          ? `Refreshing NEAR Testnet · Showing last verified snapshot from ${new Date(dashboard.lastSyncedAt).toLocaleString()}`
          : "Application data loaded · First finalized NEAR chain sync in progress...";
      case "synced":
        return `Finalized chain data · Synced ${new Date(dashboard.lastSyncedAt).toLocaleString()}`;
      case "stale":
        return `Showing stale verified snapshot · Last synced ${new Date(dashboard.lastSyncedAt).toLocaleString()}`;
      case "error":
        return dashboard.lastSyncedAt
          ? `Chain refresh failed · Showing last verified snapshot from ${new Date(dashboard.lastSyncedAt).toLocaleString()} · ${dashboard.chainError || "RPC error"}`
          : `Waiting for chain data · ${dashboard.chainError || "Initial sync unavailable"}`;
      default:
        return "Waiting for first finalized NEAR chain sync...";
    }
  }

  // ─── Render ──────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0f0a] text-white">
      {/* Notice Toast */}
      {notice && (
        <div
          className={`fixed top-20 right-6 z-[200] max-w-md rounded-xl border px-5 py-4 text-sm shadow-2xl ${
            notice.type === "success"
              ? "border-lime-400/40 bg-lime-400/10 text-lime-100"
              : notice.type === "error"
                ? "border-red-400/40 bg-red-400/10 text-red-100"
                : notice.type === "warning"
                  ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                  : "border-white/20 bg-white/10 text-white"
          }`}
        >
          <div className="whitespace-pre-wrap break-words">{notice.message}</div>
          <button
            onClick={() => setNotice(null)}
            className="mt-2 text-xs opacity-60 hover:opacity-100"
          >
            关闭
          </button>
        </div>
      )}

      {/* Top Navigation */}
      <nav className="sticky top-0 z-50 border-b border-white/10 bg-black/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-8 py-5">
          <div className="flex items-center gap-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-lime-400 text-xl font-bold text-black">
              AB
            </div>
            <div>
              <div className="text-2xl font-semibold tracking-tighter">AgentBiz OS</div>
              <div className="-mt-1 text-xs text-lime-400">
                Multi-Agent Autonomous Business • Testnet
              </div>
            </div>
          </div>

          <div className="flex items-center gap-8 text-sm">
            {(
              [
                ["dashboard", TrendingUp, "Dashboard"],
                ["agents", Users, "AI Agents"],
                ["orders", Package, "Orders"],
                ["supplier", FileText, "Supplier Portal"],
                ["finance", ShieldCheck, "Finance Desk"],
              ] as const
            ).map(([key, Icon, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-2 transition-colors hover:text-lime-400 ${
                  activeTab === key ? "text-lime-400" : "text-white/70"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 rounded-2xl bg-white/10 px-3 py-1.5 text-xs">
              <div className="h-2 w-2 animate-pulse rounded-full bg-lime-400" />
              LIVE TESTNET
            </div>

            {/* Role Switcher */}
            <div className="relative">
              <button
                type="button"
                aria-expanded={roleMenuOpen}
                onClick={() => setRoleMenuOpen(!roleMenuOpen)}
                className="flex min-w-[220px] items-center justify-between gap-3 rounded-xl border border-slate-600 bg-slate-900 px-4 py-2.5 text-sm text-slate-50 hover:border-lime-400"
              >
                <span>{ROLE_LABELS[currentAccount] || currentAccount}</span>
                <span className="text-lime-400">{roleMenuOpen ? "▴" : "▾"}</span>
              </button>
              {roleMenuOpen && (
                <div className="absolute right-0 top-full z-[100] mt-2 w-64 rounded-xl border border-slate-600 bg-slate-900 p-2 shadow-2xl">
                  {ROLE_OPTIONS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setCurrentAccount(value);
                        setRoleMenuOpen(false);
                      }}
                      className={`block w-full rounded-lg px-3 py-2.5 text-left text-sm ${
                        currentAccount === value
                          ? "bg-lime-900 text-lime-200"
                          : "text-slate-50 hover:bg-slate-800"
                      }`}
                    >
                      {label}
                      {currentAccount === value ? "  ✓" : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleConnectWallet}
              className="flex items-center gap-2 rounded-2xl bg-white px-6 py-2 text-sm font-medium text-black transition-colors hover:bg-lime-400"
            >
              <Wallet className="h-4 w-4" />
              Connect / Switch Wallet
            </button>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-8 py-10">
        {/* ─── Dashboard ─────────────────────────── */}
        {activeTab === "dashboard" && (
          <div>
            <h1 className="mb-2 text-5xl font-semibold tracking-tighter">Business Dashboard</h1>
            <p className="mb-3 text-white/60">
              NEAR Testnet · Contract: {CONTRACT_ID}
            </p>
            <p className="mb-6 text-xs text-white/40">{getSyncStatusText()}</p>
            <p className="mb-8 text-xs text-amber-300/80">
              Order IDs are discovered from the application database; escrow status and amounts are
              verified against the contract.
            </p>

            {/* Treasury Cards */}
            <div className="mb-12 grid grid-cols-1 gap-6 md:grid-cols-4">
              {[
                {
                  label: "TREASURY AVAILABLE",
                  value: dashboard.treasuryNear,
                  color: "text-lime-400",
                },
                {
                  label: "LOCKED IN ESCROW",
                  value: dashboard.lockedNear,
                  color: "text-amber-400",
                },
                {
                  label: "TOTAL SPENT",
                  value: dashboard.spentNear,
                  color: "text-white",
                },
                {
                  label: "ACTIVE ORDERS",
                  value: loading ? null : dashboard.activeOrders,
                  color: "text-white",
                  isCount: true,
                },
              ].map((card) => (
                <div
                  key={card.label}
                  className="rounded-3xl border border-white/10 bg-white/5 p-8"
                >
                  <div className="text-sm text-white/50">{card.label}</div>
                  <div className={`mt-3 font-mono text-6xl font-light ${card.color}`}>
                    {card.value === null || card.value === undefined
                      ? "—"
                      : card.isCount
                        ? card.value
                        : Number(card.value).toFixed(4)}
                  </div>
                  {!card.isCount && <div className="mt-1 text-sm text-white/40">NEAR</div>}
                </div>
              ))}
            </div>

            {/* Create Order */}
            <div className="mb-12 rounded-3xl border border-white/10 bg-white/5 p-8">
              <h3 className="mb-6 flex items-center gap-3 text-xl">
                <Plus className="text-lime-400" /> Create New Order (Real Chain Transaction)
              </h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                <select
                  value={newOrder.agent}
                  onChange={(e) => setNewOrder({ ...newOrder, agent: e.target.value })}
                  className="rounded-2xl border border-white/20 bg-black px-6 py-4 text-white"
                >
                  <option value="agent.stormxu.testnet">Agent A - Market Research</option>
                  <option value="agent2.stormxu.testnet">Agent B - Development</option>
                  <option value="agent3.stormxu.testnet">Agent C - Marketing</option>
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  value={newOrder.amount}
                  onChange={(e) => setNewOrder({ ...newOrder, amount: e.target.value })}
                  placeholder="0.1 NEAR"
                  className="rounded-2xl border border-white/20 bg-black px-6 py-4 text-white"
                />
                <input
                  value={newOrder.description}
                  onChange={(e) => setNewOrder({ ...newOrder, description: e.target.value })}
                  placeholder="e.g. Professional logo suite and brand kit"
                  className="col-span-2 rounded-2xl border border-white/20 bg-black px-6 py-4 text-white"
                />
                <button
                  onClick={createNewOrder}
                  disabled={submitting}
                  className="rounded-2xl bg-lime-400 px-10 font-semibold text-black transition-all hover:bg-white disabled:opacity-50"
                >
                  {submitting ? "Signing with Wallet..." : "Create Order on Chain"}
                </button>
              </div>
              <p className="mt-4 text-xs text-white/60">
                Current role: <span className="font-mono text-lime-400">{currentAccount}</span>.
                This calls <span className="font-mono">create_escrow</span> on{" "}
                <span className="font-mono">{CONTRACT_ID}</span> with real wallet signature.
              </p>
            </div>

            {/* Recent Orders */}
            <div>
              <h3 className="mb-6 flex items-center justify-between text-xl">
                Recent Orders
                <button
                  onClick={loadDashboard}
                  className="text-xs text-lime-400 hover:underline"
                >
                  Refresh from chain
                </button>
              </h3>
              <div className="space-y-3">
                {dashboard.orders.length === 0 && !loading && (
                  <div className="rounded-3xl border border-white/10 bg-white/5 p-8 text-center text-white/50">
                    暂无订单
                  </div>
                )}
                {dashboard.orders.map((order) => (
                  <div
                    key={order.id}
                    className="group flex items-center justify-between rounded-3xl border border-white/10 bg-white/5 p-6 transition-colors hover:border-lime-400/30"
                  >
                    <div className="flex items-center gap-6">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-2xl">
                        📦
                      </div>
                      <div>
                        <div className="font-mono text-lg">{order.id}</div>
                        <div className="text-sm text-white/60">
                          {order.agent_id} → {order.supplier_id}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl font-light text-lime-400">
                        {order.amount_near === null
                          ? "—"
                          : order.amount_near.toFixed(4)}{" "}
                        <span className="align-super text-xs">NEAR</span>
                      </div>
                      <div
                        className={`mt-2 inline-block rounded-full px-5 py-1 text-xs ${
                          order.status === "Released"
                            ? "bg-lime-400/10 text-lime-400"
                            : order.status === "Submitted"
                              ? "bg-amber-400/10 text-amber-400"
                              : "bg-white/10 text-white/60"
                        }`}
                      >
                        {order.status}
                      </div>
                    </div>
                    <a
                      href={`https://testnet.nearblocks.io/address/${CONTRACT_ID}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-lime-400 opacity-0 underline group-hover:opacity-100"
                    >
                      Contract →
                    </a>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── Agents ────────────────────────────── */}
        {activeTab === "agents" && (
          <div>
            <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-4xl font-semibold tracking-tighter">AI Agent Cluster</h1>
                <p className="mt-2 text-sm text-white/50">
                  Database registry and finalized NEAR contract permissions are shown separately.
                </p>
              </div>
              <button
                onClick={refreshAgentChainState}
                disabled={agentChainLoading}
                className="rounded-xl bg-lime-400 px-5 py-3 text-sm font-semibold text-black disabled:opacity-50"
              >
                {agentChainLoading ? "Refreshing..." : "Refresh On-chain State"}
              </button>
            </div>

            <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-6">
              <div className="text-xs uppercase tracking-widest text-white/40">
                Contract Owner
              </div>
              <div className="mt-2 font-mono text-lg text-lime-400">
                {chainOwner || "Loading owner..."}
              </div>
              <div className="mt-3 text-xs text-white/50">
                Connected wallet: {connectedWallet || "Not connected"}
              </div>
              <div className="mt-2 text-xs">
                {connectedWallet && chainOwner && connectedWallet === chainOwner ? (
                  <span className="text-lime-400">
                    Owner wallet verified · Write access available
                  </span>
                ) : (
                  <span className="text-amber-400">
                    Read-only · Connect the contract owner wallet to manage permissions
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {dashboard.agents.map((agent) => {
                const chain = agentChainState[agent.account_id];
                const authorized = Boolean(chain && BigInt(chain.limit || "0") > 0n);
                const isFinance = agent.account_id === knownRoles.finance;
                const isOwner = agent.account_id === chainOwner;
                const canManage = Boolean(
                  connectedWallet &&
                    chainOwner &&
                    connectedWallet === chainOwner &&
                    !isFinance &&
                    !isOwner &&
                    chain?.accountExists === true
                );

                return (
                  <div
                    key={agent.account_id}
                    className="rounded-3xl border border-white/10 bg-white/5 p-7"
                  >
                    <div className="break-all font-mono text-sm text-lime-400">
                      {agent.account_id}
                    </div>
                    <div className="mt-3 text-2xl font-medium">{agent.name}</div>
                    <div className="mt-1 text-sm text-white/50">{agent.role}</div>

                    <div className="mt-6 space-y-3 border-t border-white/10 pt-5 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="text-white/50">Database registry</span>
                        <span className={agent.is_active ? "text-lime-400" : "text-white/50"}>
                          {agent.is_active ? "ACTIVE" : "PAUSED"}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-white/50">On-chain permission</span>
                        <span className={authorized ? "text-lime-400" : "text-amber-400"}>
                          {agentChainLoading && !chain
                            ? "LOADING"
                            : chain
                              ? authorized
                                ? "AUTHORIZED"
                                : "NOT AUTHORIZED"
                              : "NOT LOADED"}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-white/50">NEAR account</span>
                        <span>
                          {chain?.accountExists === true
                            ? "EXISTS"
                            : chain?.accountExists === false
                              ? "NOT FOUND"
                              : "UNKNOWN"}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-white/50">Account balance</span>
                        <span className="font-mono">
                          {chain?.balance != null ? `${chain.balance} NEAR` : "—"}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-white/50">Contract order limit</span>
                        <span className="font-mono text-lime-400">
                          {chain ? `${formatYocto(chain.limit)} NEAR` : "—"}
                        </span>
                      </div>
                      {chain?.error && (
                        <p className="break-words text-xs text-amber-400">{chain.error}</p>
                      )}
                    </div>

                    {isFinance || isOwner ? (
                      <p className="mt-6 text-xs text-white/40">
                        {isFinance
                          ? "Finance Approver cannot also be an Agent under the contract rules."
                          : "The contract owner cannot also be an Agent."}
                      </p>
                    ) : (
                      <div className="mt-6 border-t border-white/10 pt-5">
                        <label className="mb-2 block text-xs text-white/50">
                          New per-order limit (NEAR)
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={agentLimitInputs[agent.account_id] ?? "0.1"}
                          onChange={(e) =>
                            setAgentLimitInputs((old) => ({
                              ...old,
                              [agent.account_id]: e.target.value,
                            }))
                          }
                          className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 font-mono text-white outline-none focus:border-lime-400"
                        />
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <button
                            onClick={() => changeAgentAuthorization(agent.account_id, true)}
                            disabled={!canManage || Boolean(agentAction) || agentChainLoading}
                            className="rounded-xl bg-lime-400 py-3 text-xs font-semibold text-black disabled:opacity-30"
                          >
                            {agentAction === `authorize:${agent.account_id}`
                              ? "Submitting..."
                              : authorized
                                ? "Update Limit"
                                : "Authorize"}
                          </button>
                          <button
                            onClick={() => changeAgentAuthorization(agent.account_id, false)}
                            disabled={!canManage || !authorized || Boolean(agentAction)}
                            className="rounded-xl border border-red-400/40 py-3 text-xs font-semibold text-red-300 disabled:opacity-30"
                          >
                            {agentAction === `revoke:${agent.account_id}`
                              ? "Submitting..."
                              : "Revoke"}
                          </button>
                        </div>
                        {!chain?.accountExists && (
                          <p className="mt-3 text-xs text-white/40">
                            {chain?.accountExists === false
                              ? "This NEAR account does not exist. Create the account before authorizing it."
                              : "Account existence has not yet been verified."}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-8 text-xs text-white/40">
              On-chain permission is read from get_agent_limit(). A positive limit means authorized;
              zero means not authorized. Database ACTIVE status is not proof of contract permission.
              All permission changes require the contract owner&apos;s wallet signature.
            </p>
          </div>
        )}

        {/* ─── Orders ────────────────────────────── */}
        {activeTab === "orders" && (
          <div>
            <h1 className="mb-8 text-4xl font-semibold tracking-tighter">Orders &amp; Escrow</h1>
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8">
              <h3 className="mb-6 text-xl">Live Orders on {CONTRACT_ID}</h3>
              <div className="space-y-4">
                {dashboard.orders.length === 0 && (
                  <div className="py-12 text-center text-white/50">暂无订单</div>
                )}
                {dashboard.orders.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/40 p-6"
                  >
                    <div>
                      <div className="font-mono text-lg">{order.id}</div>
                      <div className="text-sm text-white/60">
                        {order.agent_id} → {order.supplier_id} •{" "}
                        {order.amount_near === null
                          ? "Amount unavailable"
                          : `${order.amount_near.toFixed(4)} NEAR`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={`inline rounded-full px-6 py-2 text-sm font-medium ${
                          order.status === "Released"
                            ? "bg-lime-400 text-black"
                            : order.status === "Submitted"
                              ? "bg-amber-400/20 text-amber-400"
                              : "bg-white/10 text-white"
                        }`}
                      >
                        {order.status}
                      </div>
                      <a
                        href={`https://testnet.nearblocks.io/address/${CONTRACT_ID}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 block text-xs text-lime-400 hover:underline"
                      >
                        Contract →
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── Supplier Portal ───────────────────── */}
        {activeTab === "supplier" && (
          <div>
            <h1 className="mb-8 text-4xl font-semibold tracking-tighter">Supplier Portal</h1>
            <div className="mx-auto max-w-md rounded-3xl border border-white/10 bg-white/5 p-10">
              <h3 className="mb-8 text-center text-xl">Submit Delivery + SHA-256</h3>
              <input
                type="text"
                placeholder="Order ID (e.g. AGENTBIZ-AI-123456)"
                value={delivery.orderId}
                onChange={(e) => setDelivery({ ...delivery, orderId: e.target.value })}
                className="mb-4 w-full rounded-2xl border border-white/20 bg-black px-6 py-4 text-white"
              />
              <input
                type="text"
                placeholder="Delivery description"
                value={delivery.description}
                onChange={(e) => setDelivery({ ...delivery, description: e.target.value })}
                className="mb-4 w-full rounded-2xl border border-white/20 bg-black px-6 py-4 text-white"
              />
              <input
                type="text"
                placeholder="SHA-256 Hash (or click Generate)"
                value={delivery.hash}
                onChange={(e) => setDelivery({ ...delivery, hash: e.target.value })}
                className="mb-8 w-full rounded-2xl border border-white/20 bg-black px-6 py-4 font-mono text-sm text-white"
              />
              <div className="flex gap-3">
                <button
                  onClick={generateSha256}
                  className="flex-1 rounded-2xl bg-white/10 py-4 text-sm font-medium text-white hover:bg-white/20"
                >
                  Generate SHA-256
                </button>
                <button
                  onClick={submitDelivery}
                  disabled={submitting}
                  className="flex-1 rounded-2xl bg-lime-400 py-4 font-semibold text-black hover:bg-white disabled:opacity-60"
                >
                  {submitting ? "Signing..." : "Submit to Contract"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Finance Desk ──────────────────────── */}
        {activeTab === "finance" && (
          <div>
            <h1 className="mb-8 text-4xl font-semibold tracking-tighter">Finance Desk</h1>
            <div className="mx-auto max-w-md rounded-3xl border border-white/10 bg-white/5 p-10">
              <h3 className="mb-8 text-center text-xl">Verify, Approve &amp; Release</h3>
              <input
                type="text"
                placeholder="Order ID"
                value={approval.orderId}
                onChange={(e) => setApproval({ ...approval, orderId: e.target.value })}
                className="mb-6 w-full rounded-2xl border border-white/20 bg-black px-6 py-4 font-mono text-white"
              />
              <textarea
                placeholder="Notes (e.g. Hash verified, delivery accepted, quality good)"
                value={approval.notes}
                onChange={(e) => setApproval({ ...approval, notes: e.target.value })}
                className="mb-8 h-28 w-full rounded-2xl border border-white/20 bg-black px-6 py-4 text-white"
              />
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={approveDelivery}
                  disabled={submitting}
                  className="rounded-2xl bg-lime-400 py-4 font-semibold text-black transition-colors hover:bg-white disabled:opacity-50"
                >
                  Approve Delivery
                </button>
                <button
                  onClick={releaseFunds}
                  disabled={submitting}
                  className="rounded-2xl bg-white py-4 font-semibold text-black transition-colors hover:bg-lime-400 disabled:opacity-50"
                >
                  Release Funds
                </button>
              </div>
              <p className="mt-8 text-center text-xs text-white/50">
                Acting as {currentAccount}. Every action triggers a real wallet signature and
                contract call on {CONTRACT_ID}.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
