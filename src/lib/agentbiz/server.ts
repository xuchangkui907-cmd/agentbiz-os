import { createServerFn } from "@tanstack/react-start";

const CONTRACT_ID = "agentbiz.stormxu.testnet";
const RPC_URL = "https://rpc.testnet.near.org";

// One in-flight dashboard refresh per server process.
// Repeated requests share the same finalized-chain refresh.
let dashboardRefreshInFlight: Promise<any> | null = null;

type ChainEscrow = {
  payer: string;
  supplier: string;
  amount: string;
  submitted_hash: string | null;
  status: string | Record<string, unknown>;
};

// Schedule RPC request starts at a controlled interval.
// Requests may execute concurrently; only slot reservation is serialized.
let serverRpcQueue: Promise<void> = Promise.resolve();
let serverLastRpcAt = 0;

async function acquireServerRpcSlot() {
  let release!: () => void;

  const previous = serverRpcQueue;
  serverRpcQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    const waitMs = Math.max(
      0,
      350 - (Date.now() - serverLastRpcAt),
    );

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    serverLastRpcAt = Date.now();
  } finally {
    release();
  }
}

async function callView(methodName: string, args: Record<string, unknown> = {}) {
  const run = async () => {
    const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");

    for (let attempt = 0; attempt < 3; attempt++) {
      await acquireServerRpcSlot();

      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "agentbiz-dashboard",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: CONTRACT_ID,
            method_name: methodName,
            args_base64: argsBase64,
          },
        }),
      });

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After") || 0);
        const delay = retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : 1000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      const payload: any = await response.json();
      if (!response.ok || payload.error) {
        const message = payload.error?.message || `NEAR RPC HTTP ${response.status}`;
        if (/429|rate.?limit|too many requests/i.test(message) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(message);
      }

      if (!Array.isArray(payload.result?.result)) {
        throw new Error(`Invalid RPC response for ${methodName}`);
      }
      return JSON.parse(Buffer.from(payload.result.result).toString("utf8"));
    }
    throw new Error(`NEAR RPC ${methodName}: retry limit reached`);
  };

  return run();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const workerCount = Math.min(concurrency, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  });

  await Promise.all(workers);

  if (failed) {
    throw firstError;
  }

  return results;
}

function yoctoToNear(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(BigInt(String(value))) / 1e24;
}

function normalizeStatus(status: ChainEscrow["status"]): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    return Object.keys(status)[0] || "Unknown";
  }
  return "Unknown";
}

type CreateAgentBizOrderInput = {
  id: string;
  agent_id: string;
  amount_near: number;
  supplier_id: string;
};

type UpdateAgentBizOrderInput = {
  id: string;
  updates: {
    status?: string;
    delivery_hash?: string | null;
  };
};


const ACTIVE_ESCROW_STATUSES = new Set([
  "Open",
  "Submitted",
  "Approved",
  "Releasing",
  "Refunding",
]);

function makeDashboardFromSnapshot(
  dbData: any,
  snapshot: any,
  snapshotRow: any,
) {
  const snapshotOrders: any[] = Array.isArray(snapshot?.orders)
    ? snapshot.orders
    : [];

  const chainOrders = new Map(
    snapshotOrders.map((order: any) => [order.id, order]),
  );

  const orders = dbData.orders.map((order: any) => {
    const verified = chainOrders.get(order.id);

    if (verified) {
      return { ...order, ...verified };
    }

    return {
      ...order,
      amount_near: null,
      status: "Awaiting chain verification",
      delivery_hash: undefined,
      chainFound: false,
      chainError: null,
    };
  });

  const syncedAt = snapshotRow?.synced_at
    ? new Date(snapshotRow.synced_at).toISOString()
    : "";

  const ageMs = syncedAt
    ? Math.max(0, Date.now() - new Date(syncedAt).getTime())
    : Number.POSITIVE_INFINITY;

  let chainSyncStatus = "never";

  if (snapshotRow?.status === "error") {
    chainSyncStatus = "error";
  } else if (snapshot) {
    chainSyncStatus = ageMs > 60000 ? "stale" : "synced";
  }

  return {
    treasuryNear: snapshot?.treasuryNear ?? null,
    lockedNear: snapshot?.lockedNear ?? null,
    spentNear: snapshot?.spentNear ?? null,
    activeOrders: snapshot
      ? Number(snapshot.activeOrders ?? 0)
      : 0,
    orders,
    agents: dbData.agents,
    chainAvailable: Boolean(snapshot),
    chainError: snapshotRow?.last_error ?? null,
    chainOwner: snapshot?.chainOwner ?? null,
    chainPaused: snapshot?.chainPaused ?? null,
    lastSyncedAt: syncedAt,
    orderIndexSource: snapshot?.orderIndexSource ?? "database",
    orderIndexStatus: snapshot?.orderIndexStatus ?? "not_run",
    orderIndexError: snapshot?.orderIndexError ?? null,
    orderIndexScannedTransactions:
      snapshot?.orderIndexScannedTransactions ?? 0,
    orderIndexImportedOrders: snapshot?.orderIndexImportedOrders ?? 0,
    chainSyncStatus,
  };
}


const FASTNEAR_TX_URL = "https://tx.test.fastnear.com";

type FastNearAccountTx = {
  transaction_hash: string;
  tx_block_height: number;
  tx_block_timestamp: string;
};

function yoctoToNearExact(value: string): string {
  const amount = BigInt(value);
  if (amount < 0n) throw new Error("Negative escrow amount");

  const unit = 10n ** 24n;
  const whole = amount / unit;
  const fraction = (amount % unit).toString().padStart(24, "0");
  const trimmed = fraction.replace(/0+$/, "");

  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

async function fastNearPost(path: string, body: Record<string, unknown>) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${FASTNEAR_TX_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify(body),
      });

      const payload: any = await response.json();

      if (!response.ok || payload?.error) {
        throw new Error(
          payload?.error?.message ||
          payload?.message ||
          `FastNear HTTP ${response.status}`,
        );
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, 700 * (attempt + 1)),
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || "FastNear request failed"));
}

async function fetchFastNearAccountPage(resumeToken?: string | null) {
  const body: Record<string, unknown> = {
    account_id: CONTRACT_ID,
    is_function_call: true,
    is_success: true,
    desc: true,
    limit: 50,
  };

  if (resumeToken) body.resume_token = resumeToken;

  const payload = await fastNearPost("/v0/account", body);

  if (!Array.isArray(payload?.account_txs)) {
    throw new Error("FastNear response has no account_txs array");
  }

  return {
    records: payload.account_txs as FastNearAccountTx[],
    resumeToken:
      typeof payload.resume_token === "string" && payload.resume_token
        ? payload.resume_token
        : null,
  };
}

async function fetchFastNearTransactionDetails(hashes: string[]) {
  if (hashes.length === 0) return [];

  const payload = await fastNearPost("/v0/transactions", {
    tx_hashes: hashes,
  });

  if (!Array.isArray(payload?.transactions)) {
    throw new Error("FastNear transaction response has no transactions array");
  }

  return payload.transactions;
}

function extractEscrowCreatedEvents(detail: any) {
  const outcomes: any[] = [];

  if (detail?.execution_outcome) {
    outcomes.push(detail.execution_outcome);
  }

  for (const receipt of detail?.receipts || []) {
    if (receipt?.execution_outcome) {
      outcomes.push(receipt.execution_outcome);
    }
  }

  const events: Array<{
    orderId: string;
    payer: string;
    amountYocto: string;
  }> = [];

  for (const execution of outcomes) {
    const outcome = execution?.outcome;

    // Only accept logs emitted by this contract.
    if (outcome?.executor_id !== CONTRACT_ID) continue;

    for (const log of outcome?.logs || []) {
      if (typeof log !== "string") continue;
      if (!log.startsWith("AGENTBIZ|ESCROW_CREATED|")) continue;

      const parts = log.split("|");
      if (
        parts.length !== 5 ||
        parts[0] !== "AGENTBIZ" ||
        !parts[2] ||
        !parts[3] ||
        !/^\d+$/.test(parts[4])
      ) {
        throw new Error(`Malformed ESCROW_CREATED log: ${log}`);
      }

      events.push({
        orderId: parts[2],
        payer: parts[3],
        amountYocto: parts[4],
      });
    }
  }

  return events;
}

async function indexFastNearBatch(
  records: FastNearAccountTx[],
  agentbiz: any,
) {
  let importedOrders = 0;

  for (let offset = 0; offset < records.length; offset += 20) {
    const batch = records.slice(offset, offset + 20);
    const hashes = batch.map((record) => record.transaction_hash);
    const details = await fetchFastNearTransactionDetails(hashes);

    const detailByHash = new Map<string, any>();
    for (const detail of details) {
      const hash = detail?.transaction?.hash;
      if (typeof hash === "string") detailByHash.set(hash, detail);
    }

    for (const record of batch) {
      const detail = detailByHash.get(record.transaction_hash);
      if (!detail) {
        throw new Error(
          `FastNear omitted transaction ${record.transaction_hash}`,
        );
      }

      const events = extractEscrowCreatedEvents(detail);

      for (const event of events) {
        // The event discovers the order. The finalized contract view verifies it.
        const escrow = (await callView("get_escrow", {
          order_id: event.orderId,
        })) as ChainEscrow | null;

        if (!escrow) {
          throw new Error(
            `get_escrow returned null for ${event.orderId}`,
          );
        }

        if (escrow.payer !== event.payer) {
          throw new Error(`Payer mismatch for ${event.orderId}`);
        }

        if (BigInt(String(escrow.amount)) !== BigInt(event.amountYocto)) {
          throw new Error(`Amount mismatch for ${event.orderId}`);
        }

        if (!escrow.supplier) {
          throw new Error(`Escrow supplier missing for ${event.orderId}`);
        }

        const timestampMs =
          Number(BigInt(record.tx_block_timestamp) / 1000000n);
        const createdAt = new Date(timestampMs);

        if (!Number.isFinite(createdAt.getTime())) {
          throw new Error(`Invalid creation timestamp for ${event.orderId}`);
        }

        await agentbiz.upsertVerifiedChainOrder({
          id: event.orderId,
          agent_id: escrow.payer,
          amount_near: yoctoToNearExact(String(escrow.amount)),
          supplier_id: escrow.supplier,
          status: normalizeStatus(escrow.status),
          delivery_hash: escrow.submitted_hash ?? null,
          created_at: createdAt,
        });

        importedOrders += 1;
      }
    }
  }

  return importedOrders;
}

async function syncHistoricalAgentBizOrders(sql: any, agentbiz: any) {
  const stateRows = await sql.query(
    `SELECT last_transaction_hash
     FROM agentbiz_chain_indexer_state
     WHERE contract_id = $1
     LIMIT 1`,
    [CONTRACT_ID],
  );

  const checkpointHash = stateRows[0]?.last_transaction_hash ?? null;

  let resumeToken: string | null = null;
  let newestHash: string | null = null;
  let newestHeight: number | null = null;
  let scannedTransactions = 0;
  let importedOrders = 0;
  let reachedCheckpoint = false;
  let pageCount = 0;

  try {
    while (true) {
      pageCount += 1;
      if (pageCount > 10000) {
        throw new Error("FastNear pagination safety limit exceeded");
      }

      const page = await fetchFastNearAccountPage(resumeToken);
      if (page.records.length === 0) break;

      if (!newestHash) {
        newestHash = page.records[0].transaction_hash;
        newestHeight = Number(page.records[0].tx_block_height);
      }

      const checkpointIndex = checkpointHash
        ? page.records.findIndex(
            (record) => record.transaction_hash === checkpointHash,
          )
        : -1;

      const freshRecords = checkpointIndex >= 0
        ? page.records.slice(0, checkpointIndex)
        : page.records;

      if (freshRecords.length > 0) {
        importedOrders += await indexFastNearBatch(freshRecords, agentbiz);
        scannedTransactions += freshRecords.length;
      }

      if (checkpointIndex >= 0) {
        reachedCheckpoint = true;
        break;
      }

      if (!page.resumeToken) break;

      if (page.resumeToken === resumeToken) {
        throw new Error("FastNear returned a repeated resume_token");
      }

      resumeToken = page.resumeToken;
    }

    // Only commit the checkpoint after all transactions in the new range succeed.
    await sql.query(
      `INSERT INTO agentbiz_chain_indexer_state (
         contract_id, last_transaction_hash, last_block_height,
         last_synced_at, status, last_error, updated_at
       )
       VALUES ($1, $2, $3, NOW(), 'synced', NULL, NOW())
       ON CONFLICT (contract_id) DO UPDATE SET
         last_transaction_hash = COALESCE(
           EXCLUDED.last_transaction_hash,
           agentbiz_chain_indexer_state.last_transaction_hash
         ),
         last_block_height = COALESCE(
           EXCLUDED.last_block_height,
           agentbiz_chain_indexer_state.last_block_height
         ),
         last_synced_at = NOW(),
         status = 'synced',
         last_error = NULL,
         updated_at = NOW()`,
      [CONTRACT_ID, newestHash, newestHeight],
    );

    return {
      status: "synced",
      scannedTransactions,
      indexedOrders: importedOrders,
      reachedCheckpoint,
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "Historical order indexing failed",
    );

    try {
      await sql.query(
        `INSERT INTO agentbiz_chain_indexer_state (
           contract_id, status, last_error, updated_at
         )
         VALUES ($1, 'error', $2, NOW())
         ON CONFLICT (contract_id) DO UPDATE SET
           status = 'error',
           last_error = EXCLUDED.last_error,
           updated_at = NOW()`,
        [CONTRACT_ID, message],
      );
    } catch {
      // Keep the original indexing error.
    }

    throw error;
  }
}


async function performAgentBizChainRefresh() {
  let sql: any = null;

  try {
    const db = await import("@/lib/db");
    sql = await db.getSql();

    const orderIndexResult = await syncHistoricalAgentBizOrders(
      sql,
      db.agentbiz,
    ).catch((error: any) => ({
      status: "error",
      scannedTransactions: 0,
      indexedOrders: 0,
      error: String(error?.message || error),
    }));

    const dbData = await db.agentbiz.getDashboard();

    // Independent finalized contract reads run concurrently.
    const [
      treasuryRaw,
      lockedRaw,
      spentRaw,
      ownerRaw,
      pausedRaw,
    ] = await Promise.all([
      callView("get_treasury_available"),
      callView("get_total_locked"),
      callView("get_spent_total"),
      callView("get_owner"),
      callView("get_paused"),
    ]);

    // Escrow reads use bounded concurrency to avoid RPC rate limiting.
    const orderResults = await mapWithConcurrency(
      dbData.orders,
      4,
      async (order) => {
        const escrow = (await callView("get_escrow", {
          order_id: order.id,
        })) as ChainEscrow | null;

        if (!escrow) {
          return {
            ...order,
            amount_near: null,
            status: "Not Found on chain",
            delivery_hash: undefined,
            chainFound: false,
            chainError: null,
          };
        }

        return {
          ...order,
          amount_near: yoctoToNear(escrow.amount),
          supplier_id: escrow.supplier,
          status: normalizeStatus(escrow.status),
          delivery_hash: escrow.submitted_hash ?? undefined,
          chainFound: true,
          chainError: null,
        };
      },
    );

    const payload = {
      treasuryNear: yoctoToNear(treasuryRaw),
      lockedNear: yoctoToNear(lockedRaw),
      spentNear: yoctoToNear(spentRaw),
      activeOrders: orderResults.filter(
        (order) =>
          order.chainFound && ACTIVE_ESCROW_STATUSES.has(order.status),
      ).length,
      orders: orderResults,
      orderIndexSource: "database+fastnear",
      orderIndexStatus: orderIndexResult.status,
      orderIndexError: "error" in orderIndexResult
        ? orderIndexResult.error
        : null,
      orderIndexScannedTransactions: orderIndexResult.scannedTransactions,
      orderIndexImportedOrders: orderIndexResult.indexedOrders,
      chainOwner: String(ownerRaw),
      chainPaused: Boolean(pausedRaw),
    };

    const syncedAt = new Date().toISOString();

    await sql.query(
      `INSERT INTO agentbiz_chain_snapshots
        (snapshot_key, payload, synced_at, status, last_error, updated_at)
       VALUES ($1, $2::jsonb, $3, 'synced', NULL, NOW())
       ON CONFLICT (snapshot_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         synced_at = EXCLUDED.synced_at,
         status = 'synced',
         last_error = NULL,
         updated_at = NOW()`,
      [CONTRACT_ID, JSON.stringify(payload), syncedAt],
    );

    return {
      success: true,
      dashboard: {
        ...payload,
        agents: dbData.agents,
        chainAvailable: true,
        chainError: null,
        lastSyncedAt: syncedAt,
        orderIndexSource: "database+fastnear",
        orderIndexStatus: orderIndexResult.status,
        orderIndexError: "error" in orderIndexResult
          ? orderIndexResult.error
          : null,
        orderIndexScannedTransactions: orderIndexResult.scannedTransactions,
        orderIndexImportedOrders: orderIndexResult.indexedOrders,
        chainSyncStatus: "synced",
      },
    };
  } catch (error: any) {
    const message = String(error?.message || error || "Chain refresh failed");

    // Record the failed attempt without replacing the last successful payload.
    if (sql) {
      try {
        await sql.query(
          `INSERT INTO agentbiz_chain_snapshots
            (snapshot_key, payload, synced_at, status, last_error, updated_at)
           VALUES ($1, NULL, NULL, 'error', $2, NOW())
           ON CONFLICT (snapshot_key) DO UPDATE SET
             status = 'error',
             last_error = EXCLUDED.last_error,
             updated_at = NOW()`,
          [CONTRACT_ID, message],
        );
      } catch {
        // Preserve the original RPC error if recording the failure also fails.
      }
    }

    return {
      success: false,
      error: message,
    };
  }
}

export const getAgentBizDashboard = createServerFn({ method: "POST" }).handler(
  async () => {
    const { agentbiz, getSql } = await import("@/lib/db");

    // This path performs database reads only. It never waits for NEAR RPC.
    const dbData = await agentbiz.getDashboard();
    const sql = await getSql();

    const rows = await sql.query<{
      payload: any;
      synced_at: string | null;
      status: string;
      last_error: string | null;
    }>(
      `SELECT payload, synced_at, status, last_error
       FROM agentbiz_chain_snapshots
       WHERE snapshot_key = $1
       LIMIT 1`,
      [CONTRACT_ID],
    );

    const snapshotRow = rows[0] ?? null;
    const snapshot = snapshotRow?.payload ?? null;

    return makeDashboardFromSnapshot(dbData, snapshot, snapshotRow);
  },
);

export const refreshAgentBizChainData = createServerFn({
  method: "POST",
}).handler(async () => {
  if (dashboardRefreshInFlight) {
    return dashboardRefreshInFlight;
  }

  dashboardRefreshInFlight = performAgentBizChainRefresh().finally(() => {
    dashboardRefreshInFlight = null;
  });

  return dashboardRefreshInFlight;
});

export const createAgentBizOrder = createServerFn({ method: "POST" })
  .validator((data: CreateAgentBizOrderInput) => data)
  .handler(async ({ data }) => {
    const { agentbiz } = await import("@/lib/db");
    await agentbiz.createOrder(data);
    return { success: true };
  });

export const updateAgentBizOrder = createServerFn({ method: "POST" })
  .validator((data: UpdateAgentBizOrderInput) => data)
  .handler(async ({ data }) => {
    const { agentbiz } = await import("@/lib/db");
    await agentbiz.updateOrder(data.id, data.updates);
    return { success: true };
  });
