/**
 * AgentBiz uses one real PostgreSQL database.
 * DATABASE_URL is mandatory; there is no embedded database fallback.
 */

export type DbSource = "postgres";
export const dbSource: DbSource = "postgres";

const rawDatabaseUrl =
  typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl =
  rawDatabaseUrl && rawDatabaseUrl.trim()
    ? rawDatabaseUrl.trim()
    : undefined;

export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgReadyPromise__?: Promise<void>;
};

const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      text += `$${i + 1}${strings[i + 1]}`;
    }
    return run<T>(text, values);
  }) as unknown as Sql;

  sql.query = <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => run<T>(text, params);

  return sql;
}

function createPostgresSql(): Promise<Sql> {
  if (!databaseUrl) {
    return Promise.reject(
      new Error(
        "[db] DATABASE_URL is required. Configure the project .env file; no embedded database fallback is available.",
      ),
    );
  }

  globalRef.__pgSqlPromise__ ??= (async () => {
    const { Pool, types } = await import("pg");

    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);

    const pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    });

    pool.on("error", (err) => {
      console.error("[db] PostgreSQL idle client error:", err.message);
    });

    return toSql(async <T>(text: string, params: unknown[]) => {
      const result = await pool.query(text, params);
      return result.rows as T[];
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });

  return globalRef.__pgSqlPromise__;
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a server function or server route.",
    );
  }
  return createPostgresSql();
}

/** Shared server-only PostgreSQL SQL client. */
export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null;
    throw err;
  });
  return sqlPromise;
}

type DashboardOrderRow = {
  id: string;
  agent_id: string;
  amount_near: number | string;
  supplier_id: string;
  status: string;
  delivery_hash: string | null;
  created_at: Date | string | null;
};

type DashboardAgentRow = {
  account_id: string;
  name: string;
  role: string;
  max_single_order_near: number | string;
  is_active: boolean;
};

// AgentBiz convenience helpers (server-only)
export const agentbiz = {
  async getDashboard() {
    const sql = await getSql();

    const orders = await sql<DashboardOrderRow>`
      SELECT * FROM orders ORDER BY created_at DESC LIMIT 10
    `;

    const agents = await sql<DashboardAgentRow>`
      SELECT * FROM agents
    `;

    return {
      // Chain metrics must come from finalized contract reads, never DB defaults.
      treasuryNear: null,
      lockedNear: null,
      spentNear: null,
      activeOrders: 0,
      orders: orders.map((row) => ({
        ...row,
        amount_near: Number(row.amount_near),
        delivery_hash: row.delivery_hash ?? undefined,
        created_at: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at ?? ""),
      })),
      agents: agents.map((row) => ({
        ...row,
        max_single_order_near: Number(row.max_single_order_near),
      })),
    };
  },

  async getOrders() {
    const sql = await getSql();
    return await sql`SELECT * FROM orders ORDER BY created_at DESC`;
  },

  async getOrder(id: string) {
    const sql = await getSql();
    const rows = await sql`SELECT * FROM orders WHERE id = ${id}`;
    return rows[0];
  },

  async createOrder(data: {
    id: string;
    agent_id: string;
    amount_near: number;
    supplier_id: string;
  }) {
    const sql = await getSql();

    const rows = await sql`
      INSERT INTO orders (id, agent_id, amount_near, supplier_id)
      VALUES (
        ${data.id},
        ${data.agent_id},
        ${data.amount_near},
        ${data.supplier_id}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;

    if (rows[0]) {
      return rows[0];
    }

    // Idempotent retry: accept only the exact same order.
    const existingRows = await sql`
      SELECT * FROM orders WHERE id = ${data.id}
    `;

    const existing = existingRows[0];

    if (!existing) {
      throw new Error(
        `Order ${data.id} conflicted but could not be loaded`
      );
    }

    const sameOrder =
      existing.agent_id === data.agent_id &&
      existing.supplier_id === data.supplier_id &&
      Number(existing.amount_near) === Number(data.amount_near);

    if (!sameOrder) {
      throw new Error(
        `Order ID conflict: ${data.id} already exists with different order data`
      );
    }

    return existing;
  },


  async upsertVerifiedChainOrder(data: {
    id: string;
    agent_id: string;
    amount_near: string;
    supplier_id: string;
    status: string;
    delivery_hash: string | null;
    created_at: Date;
  }) {
    const sql = await getSql();

    const rows = await sql.query(
      `INSERT INTO orders (
         id, agent_id, amount_near, supplier_id,
         status, delivery_hash, created_at, updated_at
       )
       VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         delivery_hash = EXCLUDED.delivery_hash,
         updated_at = NOW()
       WHERE orders.agent_id = EXCLUDED.agent_id
         AND orders.supplier_id = EXCLUDED.supplier_id
         AND orders.amount_near = EXCLUDED.amount_near
       RETURNING *`,
      [
        data.id,
        data.agent_id,
        data.amount_near,
        data.supplier_id,
        data.status,
        data.delivery_hash,
        data.created_at,
      ],
    );

    if (rows[0]) return rows[0];

    const existing = await sql.query(
      "SELECT * FROM orders WHERE id = $1",
      [data.id],
    );

    if (!existing[0]) {
      throw new Error(`Verified order ${data.id} could not be inserted`);
    }

    throw new Error(
      `Chain order identity conflict for ${data.id}: existing agent, supplier, or amount differs from finalized escrow`,
    );
  },

  async updateOrder(
    id: string,
    updates: { status?: string; delivery_hash?: string | null },
  ) {
    const sql = await getSql();
    const entries = Object.entries(updates);

    if (entries.length === 0) {
      throw new Error("No order fields supplied for update");
    }

    const allowedFields = new Set(["status", "delivery_hash"]);

    for (const [key] of entries) {
      if (!allowedFields.has(key)) {
        throw new Error(`Unsupported order update field: ${key}`);
      }
    }

    const assignments = entries
      .map(([key], index) => `${key} = $${index + 1}`)
      .join(", ");

    const values = entries.map(([, value]) => value);

    const rows = await sql.query(
      `UPDATE orders
       SET ${assignments}, updated_at = NOW()
       WHERE id = $${values.length + 1}
       RETURNING *`,
      [...values, id],
    );

    return rows[0];
  },

  async recordTransaction(tx: any) {
    const sql = await getSql();
    return await sql`INSERT INTO transactions ${sql(tx)}`;
  }
};

/**
 * Verify the real PostgreSQL connection before the application serves traffic.
 * Schema changes are applied only by the explicit db:migrate command.
 */
export function ensureDbReady(): Promise<void> {
  globalRef.__pgReadyPromise__ ??= getSql()
    .then((sql) => sql.query("SELECT 1"))
    .then(() => undefined)
    .catch((err) => {
      globalRef.__pgReadyPromise__ = undefined;
      throw err;
    });

  return globalRef.__pgReadyPromise__;
}
