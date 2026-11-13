CREATE TABLE IF NOT EXISTS agentbiz_chain_indexer_state (
  contract_id TEXT PRIMARY KEY,
  last_transaction_hash TEXT,
  last_block_height BIGINT,
  last_synced_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders
  ALTER COLUMN amount_near TYPE NUMERIC(39,24)
  USING amount_near::NUMERIC(39,24);
