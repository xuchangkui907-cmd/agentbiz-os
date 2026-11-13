CREATE TABLE IF NOT EXISTS agentbiz_chain_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  payload JSONB,
  synced_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agentbiz_chain_snapshots_updated_at
  ON agentbiz_chain_snapshots (updated_at);
