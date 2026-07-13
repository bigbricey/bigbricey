-- Watch targets (user-defined floors/ceilings) + alerts + life graph nodes/edges

CREATE TABLE IF NOT EXISTS watch_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  measure_id TEXT NOT NULL REFERENCES measures(id),
  label TEXT,
  -- 'floor' = warn if avg below target; 'ceiling' = warn if avg above; 'range' uses both
  mode TEXT NOT NULL DEFAULT 'floor' CHECK (mode IN ('floor', 'ceiling', 'range')),
  target_min DOUBLE PRECISION,          -- floor / range low
  target_max DOUBLE PRECISION,          -- ceiling / range high
  window_days INT NOT NULL DEFAULT 7,   -- rolling average window
  unit TEXT DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'yellow' CHECK (severity IN ('yellow', 'orange', 'red')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_email, measure_id, mode)
);

CREATE INDEX IF NOT EXISTS watch_targets_user_idx ON watch_targets (user_email) WHERE enabled;

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'yellow',
  code TEXT NOT NULL,                   -- WATCH_FLOOR, WATCH_CEILING, etc.
  title TEXT NOT NULL,
  body TEXT,
  measure_id TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acked', 'resolved', 'muted')),
  day_key DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_user_open_idx ON alerts (user_email, status, created_at DESC);

-- Life graph: nodes + edges (mind-map / spider web substrate)
CREATE TABLE IF NOT EXISTS life_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- food, activity, symptom, supplement, metric, habit, note
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen DATE,
  last_seen DATE,
  event_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_email, kind, slug)
);

CREATE TABLE IF NOT EXISTS life_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  from_node UUID NOT NULL REFERENCES life_nodes(id) ON DELETE CASCADE,
  to_node UUID NOT NULL REFERENCES life_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'co_occurred', -- co_occurred | preceded | improved_after | worsened_after | related
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_email, from_node, to_node, relation)
);

CREATE INDEX IF NOT EXISTS life_nodes_user_idx ON life_nodes (user_email, kind);
CREATE INDEX IF NOT EXISTS life_edges_user_idx ON life_edges (user_email);

ALTER TABLE watch_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_edges ENABLE ROW LEVEL SECURITY;

-- Seed common default measures already exist; ensure a few more activity measures
INSERT INTO measures (id, label, unit, group_name) VALUES
  ('pushups', 'Push-ups', 'reps', 'activity'),
  ('bike_min', 'Cycling', 'min', 'activity'),
  ('climb_min', 'Climbing', 'min', 'activity'),
  ('trt_mg', 'TRT dose', 'mg', 'other'),
  ('water_oz', 'Water', 'oz', 'other')
ON CONFLICT (id) DO NOTHING;
