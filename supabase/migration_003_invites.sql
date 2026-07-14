-- Multi-user: invite codes + membership + product feedback (not food data)

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  label TEXT,
  max_uses INT,                          -- null = unlimited
  use_count INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS allowed_users (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member',   -- member | admin
  invite_code TEXT REFERENCES invite_codes(code),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS product_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  user_name TEXT,
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat',   -- chat | form
  status TEXT NOT NULL DEFAULT 'new',   -- new | read | done
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_feedback_created_idx
  ON product_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS product_feedback_status_idx
  ON product_feedback (status, created_at DESC);

ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_feedback ENABLE ROW LEVEL SECURITY;

-- Seed owner + default invite (shared with a few friends/family)
INSERT INTO invite_codes (code, label, max_uses, active, created_by)
VALUES ('FITZONE-JOIN', 'Retired public beta invite', 0, false, 'bigbricey@gmail.com')
ON CONFLICT (code) DO UPDATE SET active = false;

INSERT INTO allowed_users (email, name, role)
VALUES ('bigbricey@gmail.com', 'Brice Wilkinson', 'admin')
ON CONFLICT (email) DO UPDATE SET role = 'admin';
