-- Personal saved foods / shakes (light library for "log my shake")
CREATE TABLE IF NOT EXISTS saved_foods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  description TEXT,
  ingredients TEXT,
  serving_label TEXT NOT NULL DEFAULT '1 serving',
  kcal NUMERIC NOT NULL DEFAULT 0,
  protein NUMERIC NOT NULL DEFAULT 0,
  fat NUMERIC NOT NULL DEFAULT 0,
  carbs NUMERIC NOT NULL DEFAULT 0,
  fiber NUMERIC NOT NULL DEFAULT 0,
  sugars NUMERIC NOT NULL DEFAULT 0,
  potassium NUMERIC NOT NULL DEFAULT 0,
  magnesium NUMERIC NOT NULL DEFAULT 0,
  sodium NUMERIC NOT NULL DEFAULT 0,
  grams NUMERIC,
  extras JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_email, name_key)
);

CREATE INDEX IF NOT EXISTS saved_foods_user_idx ON saved_foods (user_email);
CREATE INDEX IF NOT EXISTS saved_foods_name_key_idx ON saved_foods (user_email, name_key);

COMMENT ON TABLE saved_foods IS 'User personal food/shake library for chat logging by name';
