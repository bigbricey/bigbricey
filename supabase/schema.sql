-- NutriTable Forever Log
-- Decade-scale personal health ledger: food, workouts, steps, metrics, freeform notes.
-- Extensible: new categories/nutrients/metrics auto-appear via catalog tables + JSONB.

-- ---------------------------------------------------------------------------
-- Profiles (one per Google email)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  email TEXT PRIMARY KEY,
  name TEXT,
  picture TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Category catalog (auto-grows: food, exercise, steps, sleep, custom…)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,                 -- slug e.g. food, exercise, steps, vitamin_d
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom', -- food | exercise | metric | body | note | custom
  description TEXT,
  schema_hint JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO categories (id, label, kind, description) VALUES
  ('food', 'Food', 'food', 'Meals, snacks, drinks — macros + micros'),
  ('exercise', 'Exercise', 'exercise', 'Workouts: push-ups, bench, runs, etc.'),
  ('steps', 'Steps', 'metric', 'Daily walking / step counts'),
  ('body', 'Body', 'body', 'Weight, waist, BP, glucose, sleep…'),
  ('supplement', 'Supplement', 'food', 'Pills, powders, vitamins as doses'),
  ('note', 'Note', 'note', 'Freeform diary of the day'),
  ('custom', 'Custom', 'custom', 'Anything new you invent by talking')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Nutrient / metric definitions (auto-grows when new micros appear)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS measures (
  id TEXT PRIMARY KEY,              -- potassium, magnesium, vitamin_d, steps…
  label TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',   -- mg, g, kcal, IU, steps, lb, min
  group_name TEXT DEFAULT 'other',  -- macro | mineral | vitamin | activity | body | other
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO measures (id, label, unit, group_name) VALUES
  ('kcal', 'Calories', 'kcal', 'macro'),
  ('protein', 'Protein', 'g', 'macro'),
  ('fat', 'Fat', 'g', 'macro'),
  ('carbs', 'Carbs', 'g', 'macro'),
  ('fiber', 'Fiber', 'g', 'macro'),
  ('potassium', 'Potassium', 'mg', 'mineral'),
  ('magnesium', 'Magnesium', 'mg', 'mineral'),
  ('sodium', 'Sodium', 'mg', 'mineral'),
  ('calcium', 'Calcium', 'mg', 'mineral'),
  ('iron', 'Iron', 'mg', 'mineral'),
  ('zinc', 'Zinc', 'mg', 'mineral'),
  ('vitamin_a', 'Vitamin A', 'µg', 'vitamin'),
  ('vitamin_c', 'Vitamin C', 'mg', 'vitamin'),
  ('vitamin_d', 'Vitamin D', 'IU', 'vitamin'),
  ('vitamin_e', 'Vitamin E', 'mg', 'vitamin'),
  ('vitamin_k', 'Vitamin K', 'µg', 'vitamin'),
  ('b12', 'Vitamin B12', 'µg', 'vitamin'),
  ('folate', 'Folate', 'µg', 'vitamin'),
  ('omega3', 'Omega-3', 'g', 'other'),
  ('steps', 'Steps', 'steps', 'activity'),
  ('duration_min', 'Duration', 'min', 'activity'),
  ('distance_mi', 'Distance', 'mi', 'activity'),
  ('weight_lb', 'Weight', 'lb', 'body'),
  ('reps', 'Reps', 'reps', 'activity'),
  ('sets', 'Sets', 'sets', 'activity'),
  ('load_lb', 'Load', 'lb', 'activity')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Core event stream — every thing you tell the app is an event forever
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  day_key DATE NOT NULL,                 -- America/New_York calendar day for easy charts
  title TEXT NOT NULL DEFAULT '',
  raw_text TEXT,                         -- original utterance
  source TEXT DEFAULT 'chat',            -- chat | manual | import | system
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,  -- full structured blob
  client_id TEXT,                        -- stable id from browser for upsert
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ                 -- soft delete keeps history
);

CREATE INDEX IF NOT EXISTS events_user_day_idx ON events (user_email, day_key DESC);
CREATE INDEX IF NOT EXISTS events_user_cat_day_idx ON events (user_email, category_id, day_key DESC);
CREATE INDEX IF NOT EXISTS events_user_occurred_idx ON events (user_email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_client_id_idx ON events (user_email, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_payload_gin ON events USING gin (payload);

-- ---------------------------------------------------------------------------
-- Normalized measure values — graphable forever (one row per nutrient/metric)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_measures (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  day_key DATE NOT NULL,
  measure_id TEXT NOT NULL REFERENCES measures(id),
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_measures_user_measure_day_idx
  ON event_measures (user_email, measure_id, day_key);
CREATE INDEX IF NOT EXISTS event_measures_event_idx ON event_measures (event_id);

-- ---------------------------------------------------------------------------
-- Daily rollups (materialized convenience for decade charts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_totals (
  user_email TEXT NOT NULL,
  day_key DATE NOT NULL,
  measure_id TEXT NOT NULL REFERENCES measures(id),
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, day_key, measure_id)
);

CREATE INDEX IF NOT EXISTS day_totals_user_measure_idx
  ON day_totals (user_email, measure_id, day_key);

-- ---------------------------------------------------------------------------
-- Chat transcript (optional context for the AI over years)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  role TEXT NOT NULL, -- user | assistant | system
  content TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_user_created_idx
  ON chat_messages (user_email, created_at DESC);

-- ---------------------------------------------------------------------------
-- Helpers: ensure category / measure exists (called from API)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_category(
  p_id TEXT,
  p_label TEXT,
  p_kind TEXT DEFAULT 'custom'
) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO categories (id, label, kind)
  VALUES (lower(regexp_replace(p_id, '[^a-zA-Z0-9_]+', '_', 'g')), p_label, COALESCE(p_kind, 'custom'))
  ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label
  RETURNING id INTO p_id;
  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_measure(
  p_id TEXT,
  p_label TEXT,
  p_unit TEXT DEFAULT '',
  p_group TEXT DEFAULT 'other'
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  mid TEXT;
BEGIN
  mid := lower(regexp_replace(p_id, '[^a-zA-Z0-9_]+', '_', 'g'));
  INSERT INTO measures (id, label, unit, group_name)
  VALUES (mid, p_label, COALESCE(p_unit, ''), COALESCE(p_group, 'other'))
  ON CONFLICT (id) DO UPDATE SET
    label = COALESCE(EXCLUDED.label, measures.label),
    unit = CASE WHEN EXCLUDED.unit <> '' THEN EXCLUDED.unit ELSE measures.unit END
  RETURNING id INTO mid;
  RETURN mid;
END;
$$;

-- Recompute day_totals for one user/day
CREATE OR REPLACE FUNCTION recompute_day_totals(p_email TEXT, p_day DATE)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM day_totals WHERE user_email = p_email AND day_key = p_day;
  INSERT INTO day_totals (user_email, day_key, measure_id, total, unit, updated_at)
  SELECT user_email, day_key, measure_id, SUM(value), MAX(unit), now()
  FROM event_measures em
  JOIN events e ON e.id = em.event_id
  WHERE em.user_email = p_email AND em.day_key = p_day AND e.deleted_at IS NULL
  GROUP BY user_email, day_key, measure_id;
END;
$$;

-- updated_at touch
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_touch ON events;
CREATE TRIGGER events_touch BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS profiles_touch ON profiles;
CREATE TRIGGER profiles_touch BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Service role does everything from Vercel; lock down anon
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE measures ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_measures ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- No public policies: only service_role (bypasses RLS) via our API.
-- Intentionally empty RLS = deny all for anon/authenticated keys from browsers.
