-- Random account identities and privacy-preserving product foundations.
--
-- This migration is deliberately additive. Existing email-scoped columns and
-- foreign keys remain in place while every owned row receives an immutable
-- random account_id. New privacy-sensitive services use account_id only. A
-- later, separately reviewed migration can remove the legacy compatibility
-- columns after every production caller has moved over.

BEGIN;

CREATE TABLE IF NOT EXISTS public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'export_requested', 'deletion_requested', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_id UUID;

INSERT INTO public.accounts (id, created_at, updated_at)
SELECT
  COALESCE(p.account_id, gen_random_uuid()),
  COALESCE(p.created_at, now()),
  COALESCE(p.updated_at, now())
FROM public.profiles AS p
WHERE p.account_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

UPDATE public.profiles
SET account_id = gen_random_uuid()
WHERE account_id IS NULL;

INSERT INTO public.accounts (id, created_at, updated_at)
SELECT p.account_id, COALESCE(p.created_at, now()), COALESCE(p.updated_at, now())
FROM public.profiles AS p
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.profiles
  ALTER COLUMN account_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN account_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_account_id_unique_idx
  ON public.profiles (account_id);

-- New preference writes bind to the random account id. The established merge
-- routine still performs its proven concurrency-safe JSON merge internally.
CREATE OR REPLACE FUNCTION public.merge_profile_prefs_by_account(
  p_account_id UUID,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT;
BEGIN
  IF p_account_id IS NULL OR jsonb_typeof(coalesce(p_patch, '{}'::JSONB)) <> 'object' THEN
    RAISE EXCEPTION 'invalid_profile_preferences' USING ERRCODE = '22023';
  END IF;
  SELECT email INTO v_email
  FROM public.profiles
  WHERE account_id = p_account_id
  LIMIT 1;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN public.merge_profile_prefs(v_email, p_patch);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_profile_prefs_by_account(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_profile_prefs_by_account(UUID, JSONB)
  TO service_role;

DO $profiles_account_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_account_id_fkey'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
  END IF;
END;
$profiles_account_fk$;

CREATE OR REPLACE FUNCTION public.ensure_profile_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.account_id IS NULL THEN
    NEW.account_id := gen_random_uuid();
  END IF;
  INSERT INTO public.accounts (id) VALUES (NEW.account_id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_profile_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_profile_account() TO service_role;

DROP TRIGGER IF EXISTS profiles_ensure_account ON public.profiles;
CREATE TRIGGER profiles_ensure_account
BEFORE INSERT OR UPDATE OF account_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.ensure_profile_account();

-- Authentication identity is intentionally separate from the health profile.
-- login_email is used only for sign-in/account recovery and never by new
-- health-record services. provider_subject becomes authoritative on next login.
CREATE TABLE IF NOT EXISTS public.auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  provider_subject TEXT NOT NULL CHECK (char_length(provider_subject) BETWEEN 1 AND 255),
  login_email TEXT NOT NULL CHECK (char_length(login_email) BETWEEN 3 AND 320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_email_unique_idx
  ON public.auth_identities (provider, lower(login_email));
CREATE INDEX IF NOT EXISTS auth_identities_account_idx
  ON public.auth_identities (account_id);

INSERT INTO public.auth_identities (
  account_id,
  provider,
  provider_subject,
  login_email
)
SELECT
  p.account_id,
  'google',
  'legacy:' || p.account_id::TEXT,
  lower(trim(p.email))
FROM public.profiles AS p
ON CONFLICT DO NOTHING;

-- A trusted-server-only bridge keeps legacy writers safe while account_id is
-- rolled through the application. It never accepts an account id from a
-- browser; it derives ownership from the already authenticated profile key.
CREATE OR REPLACE FUNCTION public.assign_account_id_from_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT p.account_id INTO v_account_id
  FROM public.profiles AS p
  WHERE lower(trim(p.email)) = lower(trim(NEW.user_email))
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'account_identity_missing' USING ERRCODE = '23503';
  END IF;
  NEW.account_id := v_account_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_account_id_from_profile()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_account_id_from_profile()
  TO service_role;

-- Tables created before account IDs. Backfill and require the derived owner on
-- every future insert/update while preserving their legacy email columns.
DO $account_scope_existing_tables$
DECLARE
  v_table TEXT;
  v_constraint TEXT;
  v_trigger TEXT;
  v_index TEXT;
  v_has_null BOOLEAN;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'events',
    'event_measures',
    'day_totals',
    'chat_conversations',
    'chat_messages',
    'profile_memories',
    'watch_targets',
    'alerts',
    'life_nodes',
    'life_edges',
    'saved_foods',
    'food_day_revisions',
    'llm_usage',
    'llm_quota_state',
    'product_feedback'
  ]
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS account_id UUID',
      v_table
    );
    EXECUTE format(
      'INSERT INTO public.profiles (email) SELECT DISTINCT lower(trim(owned.user_email)) FROM public.%I AS owned WHERE owned.user_email IS NOT NULL AND trim(owned.user_email) <> '''' ON CONFLICT (email) DO NOTHING',
      v_table
    );
    EXECUTE format(
      'UPDATE public.%I AS owned SET account_id = p.account_id FROM public.profiles AS p WHERE owned.account_id IS NULL AND lower(trim(owned.user_email)) = lower(trim(p.email))',
      v_table
    );

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE account_id IS NULL)',
      v_table
    ) INTO v_has_null;
    IF v_has_null THEN
      RAISE EXCEPTION 'Could not backfill account_id for table %', v_table;
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN account_id SET NOT NULL',
      v_table
    );

    v_constraint := v_table || '_account_id_fkey';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = v_constraint
        AND conrelid = to_regclass('public.' || v_table)
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE',
        v_table,
        v_constraint
      );
    END IF;

    v_index := v_table || '_account_idx';
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (account_id)',
      v_index,
      v_table
    );

    v_trigger := v_table || '_derive_account';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_trigger, v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF user_email ON public.%I FOR EACH ROW EXECUTE FUNCTION public.assign_account_id_from_profile()',
      v_trigger,
      v_table
    );
  END LOOP;
END;
$account_scope_existing_tables$;

-- Health Snapshot drafts contain no login identity and are never public.
CREATE TABLE IF NOT EXISTS public.health_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  title TEXT NOT NULL DEFAULT 'Health Snapshot'
    CHECK (char_length(title) BETWEEN 1 AND 120),
  report_text TEXT NOT NULL CHECK (char_length(report_text) <= 60000),
  structured_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_version TEXT NOT NULL DEFAULT 'health-snapshot-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (date_from <= date_to)
);

CREATE INDEX IF NOT EXISTS health_snapshots_account_created_idx
  ON public.health_snapshots (account_id, created_at DESC);

-- Repeated food corrections become structured account state, not model memory.
CREATE TABLE IF NOT EXISTS public.food_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  correction_key TEXT NOT NULL CHECK (char_length(correction_key) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('identity', 'quantity', 'preparation', 'nutrient', 'usual_portion')),
  correction JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmations INTEGER NOT NULL DEFAULT 1 CHECK (confirmations BETWEEN 1 AND 1000000),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, correction_key, kind)
);

CREATE INDEX IF NOT EXISTS food_corrections_account_active_idx
  ON public.food_corrections (account_id, active, updated_at DESC);

CREATE OR REPLACE FUNCTION public.record_food_correction(
  p_account_id UUID,
  p_correction_key TEXT,
  p_kind TEXT,
  p_correction JSONB
)
RETURNS public.food_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.food_corrections;
  v_key TEXT := left(trim(coalesce(p_correction_key, '')), 160);
BEGIN
  IF p_account_id IS NULL OR v_key = '' OR p_kind NOT IN (
    'identity', 'quantity', 'preparation', 'nutrient', 'usual_portion'
  ) OR pg_column_size(coalesce(p_correction, '{}'::JSONB)) > 4096 THEN
    RAISE EXCEPTION 'invalid_food_correction' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.food_corrections (
    account_id, correction_key, kind, correction, active
  ) VALUES (
    p_account_id, v_key, p_kind, coalesce(p_correction, '{}'::JSONB), true
  )
  ON CONFLICT (account_id, correction_key, kind)
  DO UPDATE SET
    correction = EXCLUDED.correction,
    confirmations = LEAST(public.food_corrections.confirmations + 1, 1000000),
    active = true,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_food_correction(UUID, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_food_correction(UUID, TEXT, TEXT, JSONB)
  TO service_role;

-- First-party metrics intentionally omit message, food, and health content.
CREATE TABLE IF NOT EXISTS public.product_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (char_length(event_name) BETWEEN 1 AND 80),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 3600000),
  numeric_value NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (pg_column_size(metadata) <= 4096)
);

CREATE INDEX IF NOT EXISTS product_events_account_time_idx
  ON public.product_events (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS product_events_name_time_idx
  ON public.product_events (event_name, occurred_at DESC);

-- Access/mutation audit metadata is content-free and account scoped.
CREATE TABLE IF NOT EXISTS public.account_audit_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  resource_type TEXT NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 80),
  resource_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'denied', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (pg_column_size(metadata) <= 4096)
);

CREATE INDEX IF NOT EXISTS account_audit_events_account_time_idx
  ON public.account_audit_events (account_id, occurred_at DESC);

-- A content-free audit trail covers health-record and preference mutations,
-- including legacy writers that have not yet been moved to new API helpers.
CREATE OR REPLACE FUNCTION public.audit_account_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row JSONB;
  v_account_id UUID;
  v_resource_id TEXT;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_account_id := NULLIF(v_row ->> 'account_id', '')::UUID;
  IF v_account_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  v_resource_id := coalesce(
    nullif(v_row ->> 'id', ''),
    nullif(v_row ->> 'client_id', '')
  );
  INSERT INTO public.account_audit_events (
    account_id, action, resource_type, resource_id, metadata
  ) VALUES (
    v_account_id,
    lower(TG_OP),
    TG_TABLE_NAME,
    left(v_resource_id, 160),
    '{}'::JSONB
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_account_mutation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_account_mutation() TO service_role;

DO $mutation_audit_triggers$
DECLARE
  v_table TEXT;
  v_trigger TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'profiles',
    'events',
    'event_measures',
    'saved_foods',
    'chat_conversations',
    'chat_messages',
    'profile_memories',
    'product_feedback',
    'health_snapshots',
    'food_corrections',
    'account_data_requests'
  ]
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;
    v_trigger := v_table || '_account_audit';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_trigger, v_table);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_account_mutation()',
      v_trigger,
      v_table
    );
  END LOOP;
END;
$mutation_audit_triggers$;

CREATE TABLE IF NOT EXISTS public.account_data_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('export', 'deletion')),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'verified', 'processing', 'completed', 'cancelled')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, request_type, status)
);

DROP TRIGGER IF EXISTS account_data_requests_account_audit
  ON public.account_data_requests;
CREATE TRIGGER account_data_requests_account_audit
AFTER INSERT OR UPDATE OR DELETE ON public.account_data_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_account_mutation();

CREATE TABLE IF NOT EXISTS public.account_rate_limit_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 80),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_rate_limit_account_bucket_time_idx
  ON public.account_rate_limit_events (account_id, bucket, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.consume_account_rate_limit(
  p_account_id UUID,
  p_bucket TEXT,
  p_max_events INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bucket TEXT := left(trim(coalesce(p_bucket, '')), 80);
  v_count INTEGER;
BEGIN
  IF p_account_id IS NULL OR v_bucket = ''
     OR p_max_events < 1 OR p_max_events > 1000
     OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid_rate_limit_request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('rate:' || p_account_id::TEXT || ':' || v_bucket, 0)
  );

  SELECT count(*)::INTEGER INTO v_count
  FROM public.account_rate_limit_events
  WHERE account_id = p_account_id
    AND bucket = v_bucket
    AND occurred_at >= now() - make_interval(secs => p_window_seconds);

  IF v_count >= p_max_events THEN
    RETURN false;
  END IF;

  INSERT INTO public.account_rate_limit_events (account_id, bucket)
  VALUES (p_account_id, v_bucket);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_account_rate_limit(UUID, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_account_rate_limit(UUID, TEXT, INTEGER, INTEGER)
  TO service_role;

-- Stable, bounded read service for Health Snapshot and a future read-only MCP.
-- It aggregates inside PostgreSQL and never returns meal-by-meal history.
CREATE OR REPLACE FUNCTION public.read_health_range_summary(
  p_account_id UUID,
  p_from DATE,
  p_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_account_id IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_from > p_to OR p_to - p_from > 36525 THEN
    RAISE EXCEPTION 'invalid_health_summary_range' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = '22023';
  END IF;

  WITH scoped_totals AS (
    SELECT dt.day_key, dt.measure_id, dt.total, dt.unit
    FROM public.day_totals AS dt
    WHERE dt.account_id = p_account_id
      AND dt.day_key BETWEEN p_from AND p_to
      AND dt.total::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  base_stats AS (
    SELECT
      measure_id,
      max(unit) AS unit,
      count(*)::INTEGER AS days_logged,
      avg(total) AS average,
      min(total) AS minimum,
      max(total) AS maximum,
      stddev_pop(total) AS standard_deviation,
      (array_agg(total ORDER BY day_key ASC))[1] AS first_value,
      (array_agg(total ORDER BY day_key DESC))[1] AS latest_value,
      min(day_key) AS first_day,
      max(day_key) AS latest_day
    FROM scoped_totals
    GROUP BY measure_id
  ),
  measure_stats AS (
    SELECT
      bs.*,
      (
        SELECT count(*)::INTEGER
        FROM scoped_totals AS candidate
        WHERE candidate.measure_id = bs.measure_id
          AND bs.standard_deviation IS NOT NULL
          AND bs.standard_deviation > 0
          AND abs(candidate.total - bs.average) > 2.5 * bs.standard_deviation
      ) AS outlier_count
    FROM base_stats AS bs
  ),
  active_events AS (
    SELECT e.id, e.day_key, e.category_id, e.title, e.source, e.payload, e.occurred_at
    FROM public.events AS e
    WHERE e.account_id = p_account_id
      AND e.day_key BETWEEN p_from AND p_to
      AND e.deleted_at IS NULL
  ),
  bounds AS (
    SELECT min(day_key) AS first_day, max(day_key) AS last_day
    FROM (
      SELECT day_key FROM scoped_totals
      UNION ALL
      SELECT day_key FROM active_events
    ) AS available_days
  ),
  context_events AS (
    SELECT ae.day_key, ae.category_id, left(ae.title, 300) AS title, ae.source
    FROM active_events AS ae
    WHERE ae.category_id IN ('supplement', 'note', 'body', 'custom')
       OR ae.title ~* '(symptom|medication|medicine|prescription|laboratory|lab result|blood test|pain|sleep|supplement)'
    ORDER BY ae.occurred_at DESC
    LIMIT 100
  ),
  measurement_points AS (
    SELECT day_key, measure_id, total, unit
    FROM scoped_totals
    WHERE measure_id IN (
      'weight_lb', 'waist_in', 'body_fat_pct', 'blood_pressure_systolic',
      'blood_pressure_diastolic', 'glucose_mg_dl', 'sleep_hours'
    )
    ORDER BY day_key ASC
    LIMIT 5000
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'calendar_days', (p_to - p_from + 1)
    ),
    'available_bounds', COALESCE(
      (SELECT to_jsonb(bounds) FROM bounds),
      jsonb_build_object('first_day', NULL, 'last_day', NULL)
    ),
    'coverage', jsonb_build_object(
      'days_with_any_data', (
        SELECT count(DISTINCT day_key)::INTEGER
        FROM (
          SELECT day_key FROM scoped_totals
          UNION
          SELECT day_key FROM active_events
        ) AS any_days
      ),
      'food_logged_days', (
        SELECT count(DISTINCT day_key)::INTEGER
        FROM active_events WHERE category_id = 'food'
      ),
      'workout_logged_days', (
        SELECT count(DISTINCT day_key)::INTEGER
        FROM active_events
        WHERE category_id = 'exercise'
           OR category_id ~* '(workout|training|run|bike|lift|sport)'
      ),
      'measurement_logged_days', (
        SELECT count(DISTINCT day_key)::INTEGER
        FROM scoped_totals
        WHERE measure_id IN (
          'weight_lb', 'waist_in', 'body_fat_pct', 'blood_pressure_systolic',
          'blood_pressure_diastolic', 'glucose_mg_dl', 'sleep_hours'
        )
      )
    ),
    'measure_summaries', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'measure_id', measure_id,
          'unit', unit,
          'days_logged', days_logged,
          'average', round(average::NUMERIC, 3),
          'minimum', round(minimum::NUMERIC, 3),
          'maximum', round(maximum::NUMERIC, 3),
          'standard_deviation', CASE
            WHEN standard_deviation IS NULL THEN NULL
            ELSE round(standard_deviation::NUMERIC, 3)
          END,
          'first_value', round(first_value::NUMERIC, 3),
          'latest_value', round(latest_value::NUMERIC, 3),
          'first_day', first_day,
          'latest_day', latest_day,
          'outlier_count', outlier_count
        ) ORDER BY measure_id
      ) FROM measure_stats
    ), '[]'::JSONB),
    'measurement_points', COALESCE((
      SELECT jsonb_agg(to_jsonb(measurement_points) ORDER BY day_key, measure_id)
      FROM measurement_points
    ), '[]'::JSONB),
    'workouts', jsonb_build_object(
      'sessions', (
        SELECT count(*)::INTEGER FROM active_events
        WHERE category_id = 'exercise'
           OR category_id ~* '(workout|training|run|bike|lift|sport)'
      ),
      'days', (
        SELECT count(DISTINCT day_key)::INTEGER FROM active_events
        WHERE category_id = 'exercise'
           OR category_id ~* '(workout|training|run|bike|lift|sport)'
      )
    ),
    'food_provenance', jsonb_build_object(
      'entries', (SELECT count(*)::INTEGER FROM active_events WHERE category_id = 'food'),
      'verified_entries', (
        SELECT count(*)::INTEGER FROM active_events
        WHERE category_id = 'food'
          AND COALESCE(payload #>> '{extras,provenance,estimate_status}', '')
            IN ('verified_nutrition', 'user_confirmed')
      ),
      'estimated_entries', (
        SELECT count(*)::INTEGER FROM active_events
        WHERE category_id = 'food'
          AND COALESCE(payload #>> '{extras,provenance,estimate_status}', '')
            NOT IN ('verified_nutrition', 'user_confirmed')
      ),
      'estimated_portions', (
        SELECT count(*)::INTEGER FROM active_events
        WHERE category_id = 'food'
          AND lower(COALESCE(payload #>> '{extras,provenance,portion_estimated}', 'false')) = 'true'
      )
    ),
    'recorded_context', COALESCE((
      SELECT jsonb_agg(to_jsonb(context_events) ORDER BY day_key DESC)
      FROM context_events
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.read_health_range_summary(UUID, DATE, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_health_range_summary(UUID, DATE, DATE)
  TO service_role;

CREATE OR REPLACE FUNCTION public.read_food_history_summary(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_limit INTEGER := greatest(1, least(200, coalesce(p_limit, 50)));
  v_result JSONB;
BEGIN
  IF p_account_id IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_from > p_to OR p_to - p_from > 36525 THEN
    RAISE EXCEPTION 'invalid_food_history_range' USING ERRCODE = '22023';
  END IF;

  WITH food_groups AS (
    SELECT
      left(lower(trim(coalesce(e.payload ->> 'label', e.title, 'food'))), 300) AS food_key,
      left(max(coalesce(e.payload ->> 'label', e.title, 'Food')), 300) AS label,
      count(*)::INTEGER AS times_logged,
      count(DISTINCT e.day_key)::INTEGER AS days_logged,
      min(e.day_key) AS first_logged_day,
      max(e.day_key) AS latest_logged_day,
      max(left(coalesce(e.payload ->> 'source', e.source, 'recorded'), 80)) AS source,
      sum(
        CASE
          WHEN (e.payload ->> 'grams') ~ '^[0-9]+(?:\.[0-9]+)?$'
          THEN (e.payload ->> 'grams')::NUMERIC
          ELSE 0
        END
      ) AS recorded_grams,
      count(*) FILTER (
        WHERE COALESCE(e.payload #>> '{extras,provenance,estimate_status}', '')
          IN ('verified_nutrition', 'user_confirmed')
      )::INTEGER AS verified_entries
    FROM public.events AS e
    WHERE e.account_id = p_account_id
      AND e.category_id = 'food'
      AND e.deleted_at IS NULL
      AND e.day_key BETWEEN p_from AND p_to
    GROUP BY left(lower(trim(coalesce(e.payload ->> 'label', e.title, 'food'))), 300)
    ORDER BY count(*) DESC, max(e.day_key) DESC
    LIMIT v_limit
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(food_groups)), '[]'::JSONB)
  INTO v_result
  FROM food_groups;

  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'foods', v_result,
    'aggregated', true,
    'raw_rows_returned', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.read_food_history_summary(UUID, DATE, DATE, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_food_history_summary(UUID, DATE, DATE, INTEGER)
  TO service_role;

DROP TRIGGER IF EXISTS health_snapshots_touch ON public.health_snapshots;
CREATE TRIGGER health_snapshots_touch
BEFORE UPDATE ON public.health_snapshots
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS food_corrections_touch ON public.food_corrections;
CREATE TRIGGER food_corrections_touch
BEFORE UPDATE ON public.food_corrections
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Feedback context is opt-in and bounded. Existing rows remain valid.
ALTER TABLE public.product_feedback
  ADD COLUMN IF NOT EXISTS feedback_kind TEXT NOT NULL DEFAULT 'idea',
  ADD COLUMN IF NOT EXISTS interaction_id UUID,
  ADD COLUMN IF NOT EXISTS consent_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS include_context BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS context_excerpt JSONB,
  ADD COLUMN IF NOT EXISTS trust_rating SMALLINT,
  ADD COLUMN IF NOT EXISTS correction JSONB;

ALTER TABLE public.product_feedback
  DROP CONSTRAINT IF EXISTS product_feedback_feedback_kind_check;
ALTER TABLE public.product_feedback
  ADD CONSTRAINT product_feedback_feedback_kind_check
  CHECK (feedback_kind IN ('wrong', 'correction', 'idea', 'trust'));
ALTER TABLE public.product_feedback
  DROP CONSTRAINT IF EXISTS product_feedback_trust_rating_check;
ALTER TABLE public.product_feedback
  ADD CONSTRAINT product_feedback_trust_rating_check
  CHECK (trust_rating IS NULL OR trust_rating BETWEEN 1 AND 5);

-- All privacy tables are service-role only. Empty RLS policies deny browser
-- anon/authenticated keys even if one is accidentally shipped to a client.
DO $lock_privacy_tables$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'accounts',
    'auth_identities',
    'health_snapshots',
    'food_corrections',
    'product_events',
    'account_audit_events',
    'account_data_requests',
    'account_rate_limit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', v_table);
  END LOOP;
END;
$lock_privacy_tables$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

COMMIT;
