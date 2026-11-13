export const REVENUE_USD = 100;
export const MAX_BUDGET_USD = 40;
export const USD_TO_NEAR = 0.01;
export const ORDER_ID = "demo-001";

export type OrderStatus =
  | "Created"
  | "Planned"
  | "Quoted"
  | "RejectedAttempt"
  | "Escrowing"
  | "Delivered"
  | "Settled";

export type EscrowStatus = "Open" | "Delivered" | "Released" | "Rejected";

export type SupplierQuote = {
  id: "A" | "B" | "C";
  name: string;
  amountUsd: number;
  etaHours: number;
  deliveryText: string;
};

export const SUPPLIERS: SupplierQuote[] = [
  { id: "A", name: "FastCheap", amountUsd: 25, etaHours: 4, deliveryText: "logo set v1" },
  { id: "B", name: "Balanced", amountUsd: 35, etaHours: 8, deliveryText: "logo set v2 brand kit" },
  { id: "C", name: "Premium", amountUsd: 55, etaHours: 2, deliveryText: "premium brand system" },
];

export type LedgerLine = {
  step: number;
  title: string;
  detail: string;
  tone: "neutral" | "ok" | "danger" | "chain";
};

export type EscrowView = {
  orderId: string;
  supplier: string;
  amountUsd: number;
  amountNear: string;
  deliveryHash: string | null;
  status: EscrowStatus;
  createTx: string | null;
  releaseTx: string | null;
  rejectReason: string | null;
};

export type ScenarioState = {
  orderStatus: OrderStatus;
  lines: LedgerLine[];
  quotes: SupplierQuote[];
  selectedId: "A" | "B" | "C" | null;
  rejectedId: "A" | "B" | "C" | null;
  escrow: EscrowView | null;
  treasuryNear: number;
  lockedNear: number;
  profitUsd: number | null;
  expenseUsd: number | null;
  running: boolean;
  done: boolean;
};

export const INITIAL_STATE: ScenarioState = {
  orderStatus: "Created",
  lines: [],
  quotes: [],
  selectedId: null,
  rejectedId: null,
  escrow: null,
  treasuryNear: 1,
  lockedNear: 0,
  profitUsd: null,
  expenseUsd: null,
  running: false,
  done: false,
};

export function usdToNear(usd: number) {
  return Number((usd * USD_TO_NEAR).toFixed(4));
}

export async function sha256Hex(text: string) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonical(payload: Record<string, string | number>) {
  return JSON.stringify(payload);
}

export async function txId(method: string, payload: Record<string, string | number>) {
  return sha256Hex(`${method}:${canonical(payload)}`);
}

export function pickCompliant(quotes: SupplierQuote[], maxBudget: number) {
  const ok = quotes.filter((q) => q.amountUsd <= maxBudget);
  if (ok.length === 0) return null;
  return ok.reduce((best, q) => (q.amountUsd < best.amountUsd ? q : best));
}

export function securityCheck(amountUsd: number, maxBudget: number, paused: boolean) {
  if (paused) return "ERR_PAUSED";
  if (amountUsd <= 0) return "ERR_AMOUNT";
  if (amountUsd > maxBudget) return "ERR_OVER_BUDGET";
  return null;
}

type InternalEscrow = {
  orderId: string;
  supplier: string;
  amountUsd: number;
  deliveryHash: string | null;
  status: EscrowStatus;
  createTx: string;
  releaseTx: string | null;
};

/** Mirrors contract/src/lib.rs invariants. AI never moves funds except through these calls. */
export class TreasuryContract {
  maxBudgetUsd = MAX_BUDGET_USD;
  paused = false;
  balanceNear = 1;
  private escrows = new Map<string, InternalEscrow>();

  async createEscrow(orderId: string, supplier: SupplierQuote) {
    const reason = securityCheck(supplier.amountUsd, this.maxBudgetUsd, this.paused);
    const call = {
      order_id: orderId,
      supplier: supplier.id,
      amount_usd: supplier.amountUsd,
    };
    if (reason) {
      const id = await txId("create_escrow_revert", { ...call, reason });
      return { ok: false as const, reason, tx: id };
    }
    const amountNear = usdToNear(supplier.amountUsd);
    if (this.balanceNear < amountNear) {
      return { ok: false as const, reason: "ERR_INSUFFICIENT", tx: await txId("create_escrow_revert", call) };
    }
    this.balanceNear = Number((this.balanceNear - amountNear).toFixed(4));
    const id = await txId("create_escrow", call);
    this.escrows.set(orderId, {
      orderId,
      supplier: supplier.id,
      amountUsd: supplier.amountUsd,
      deliveryHash: null,
      status: "Open",
      createTx: id,
      releaseTx: null,
    });
    return { ok: true as const, tx: id, amountNear };
  }

  async submitDelivery(orderId: string, deliveryText: string) {
    const escrow = this.escrows.get(orderId);
    if (!escrow || escrow.status !== "Open") {
      return { ok: false as const, reason: "ERR_ESCROW" };
    }
    const hash = await sha256Hex(deliveryText);
    escrow.deliveryHash = hash;
    escrow.status = "Delivered";
    const tx = await txId("submit_delivery", { order_id: orderId, sha256: hash });
    return { ok: true as const, hash, tx };
  }

  async release(orderId: string) {
    const escrow = this.escrows.get(orderId);
    if (!escrow || !escrow.deliveryHash || escrow.status !== "Delivered") {
      return { ok: false as const, reason: "ERR_NO_DELIVERY" };
    }
    escrow.status = "Released";
    const tx = await txId("release", { order_id: orderId, sha256: escrow.deliveryHash });
    escrow.releaseTx = tx;
    return { ok: true as const, tx, expenseUsd: escrow.amountUsd };
  }

  view(orderId: string): EscrowView | null {
    const escrow = this.escrows.get(orderId);
    if (!escrow) return null;
    return {
      orderId: escrow.orderId,
      supplier: escrow.supplier,
      amountUsd: escrow.amountUsd,
      amountNear: usdToNear(escrow.amountUsd).toFixed(2),
      deliveryHash: escrow.deliveryHash,
      status: escrow.status,
      createTx: escrow.createTx,
      releaseTx: escrow.releaseTx,
      rejectReason: null,
    };
  }
}

export type StepPatch = Partial<ScenarioState> & { line?: LedgerLine };

export async function buildScenario(): Promise<StepPatch[]> {
  const contract = new TreasuryContract();
  const patches: StepPatch[] = [];
  const push = (patch: StepPatch) => patches.push(patch);

  push({
    orderStatus: "Created",
    line: {
      step: 1,
      title: "Order created",
      detail: "Customer opened a $100 AI service order. Human budget cap stays at $40.",
      tone: "neutral",
    },
  });

  push({
    orderStatus: "Planned",
    line: {
      step: 2,
      title: "CEO plan",
      detail: "CEO agent locked a purchase plan. Hard budget $40. Rule: cheapest compliant quote.",
      tone: "neutral",
    },
  });

  push({
    orderStatus: "Quoted",
    quotes: SUPPLIERS,
    line: {
      step: 3,
      title: "Three quotes",
      detail: "A $25 · B $35 · C $55. Suppliers use fixed policies, not an open marketplace.",
      tone: "neutral",
    },
  });

  const over = SUPPLIERS.find((s) => s.id === "C")!;
  const rejected = await contract.createEscrow(ORDER_ID, over);
  push({
    orderStatus: "RejectedAttempt",
    rejectedId: "C",
    line: {
      step: 4,
      title: "Security rejected C",
      detail: `Policy and contract both returned ${rejected.ok ? "UNEXPECTED" : rejected.reason}. Revert tx ${rejected.tx.slice(0, 16)}…`,
      tone: "danger",
    },
  });

  const chosen = pickCompliant(SUPPLIERS, MAX_BUDGET_USD)!;
  const created = await contract.createEscrow(ORDER_ID, chosen);
  if (!created.ok) throw new Error(created.reason);
  push({
    orderStatus: "Escrowing",
    selectedId: chosen.id,
    treasuryNear: contract.balanceNear,
    lockedNear: created.amountNear,
    escrow: contract.view(ORDER_ID),
    line: {
      step: 5,
      title: "Escrow locked",
      detail: `Supplier ${chosen.id} at $${chosen.amountUsd} (${created.amountNear} NEAR). create_escrow ${created.tx.slice(0, 18)}…`,
      tone: "chain",
    },
  });

  const delivery = await contract.submitDelivery(ORDER_ID, chosen.deliveryText);
  if (!delivery.ok) throw new Error(delivery.reason);
  push({
    orderStatus: "Delivered",
    escrow: contract.view(ORDER_ID),
    line: {
      step: 6,
      title: "Delivery hash",
      detail: `SHA-256 ${delivery.hash.slice(0, 18)}… of “${chosen.deliveryText}”.`,
      tone: "ok",
    },
  });

  const released = await contract.release(ORDER_ID);
  if (!released.ok) throw new Error(released.reason);
  const expense = released.expenseUsd;
  push({
    orderStatus: "Settled",
    escrow: contract.view(ORDER_ID),
    lockedNear: 0,
    expenseUsd: expense,
    profitUsd: REVENUE_USD - expense,
    done: true,
    line: {
      step: 7,
      title: "Funds released",
      detail: `release ${released.tx.slice(0, 18)}… only after a delivery hash existed.`,
      tone: "chain",
    },
  });

  push({
    orderStatus: "Settled",
    done: true,
    line: {
      step: 8,
      title: "Profit report",
      detail: `Revenue $100 · expense $${expense} · profit $${REVENUE_USD - expense}. Demo books, testnet-scale NEAR.`,
      tone: "ok",
    },
  });

  return patches;
}
