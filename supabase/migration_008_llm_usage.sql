-- Per-user LLM token usage (OpenRouter / chat metering)
CREATE TABLE IF NOT EXISTS llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  model TEXT,
  provider TEXT DEFAULT 'openrouter',
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC,
  conversation_id UUID,
  purpose TEXT DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_usage_user_created_idx
  ON llm_usage (user_email, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_created_idx
  ON llm_usage (created_at DESC);

ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;
