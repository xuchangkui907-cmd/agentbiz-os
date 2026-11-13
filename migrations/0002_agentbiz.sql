-- AgentBiz OS schema for orders, agents, suppliers, finance, and audit log.
-- All tables are unowned (no user_id) because this is a single-business demo.
-- Funds and final state are always verified from NEAR RPC on read.

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,                    -- Unique business order identifier
  agent_id TEXT NOT NULL,                 -- which Agent created it (agent.stormxu.testnet etc)
  amount_near NUMERIC(20,10) NOT NULL,
  supplier_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',    -- Open, Submitted, Approved, Released, Refunded
  delivery_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  account_id TEXT PRIMARY KEY,            -- e.g. agent.stormxu.testnet
  name TEXT NOT NULL,
  role TEXT NOT NULL,                     -- "Market Research", "Development", "Marketing"
  max_single_order_near NUMERIC(20,10) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliveries (
  order_id TEXT REFERENCES orders(id),
  submitted_by TEXT NOT NULL,
  delivery_description TEXT,
  sha256_hash TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (order_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  order_id TEXT REFERENCES orders(id),
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  PRIMARY KEY (order_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_hash TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  method TEXT NOT NULL,                   -- create_escrow, submit_delivery, approve_delivery, release, refund
  actor TEXT NOT NULL,
  amount_near NUMERIC(20,10),
  status TEXT NOT NULL,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast dashboard and order queries
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_agent_idx ON orders(agent_id);
CREATE INDEX IF NOT EXISTS transactions_order_idx ON transactions(order_id);
