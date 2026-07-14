-- Replace a food day inside one PostgreSQL transaction. The previous REST
-- sequence could soft-delete the old day and then fail before rebuilding it.

BEGIN;

-- The original helper selected unqualified columns shared by both joined
-- tables, which can fail as ambiguous. Keep the aggregate account-scoped and
-- callable only by the trusted server role.
CREATE OR REPLACE FUNCTION public.recompute_day_totals(p_email TEXT, p_day DATE)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.day_totals
   WHERE user_email = lower(trim(p_email))
     AND day_key = p_day;

  INSERT INTO public.day_totals (
    user_email,
    day_key,
    measure_id,
    total,
    unit,
    updated_at
  )
  SELECT
    em.user_email,
    em.day_key,
    em.measure_id,
    SUM(em.value),
    MAX(em.unit),
    now()
  FROM public.event_measures AS em
  JOIN public.events AS e
    ON e.id = em.event_id
   AND e.user_email = em.user_email
  WHERE em.user_email = lower(trim(p_email))
    AND e.user_email = lower(trim(p_email))
    AND em.day_key = p_day
    AND e.deleted_at IS NULL
  GROUP BY em.user_email, em.day_key, em.measure_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_day_totals(TEXT, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_day_totals(TEXT, DATE)
  TO service_role;

-- Optimistic concurrency for full-day food snapshots. A transaction lock alone
-- serializes writers but cannot tell whether the later writer started from a
-- stale browser snapshot.
CREATE TABLE IF NOT EXISTS public.food_day_revisions (
  user_email TEXT NOT NULL REFERENCES public.profiles(email) ON DELETE CASCADE,
  day_key DATE NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, day_key)
);

ALTER TABLE public.food_day_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.food_day_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.food_day_revisions TO service_role;

INSERT INTO public.food_day_revisions (user_email, day_key, revision)
SELECT DISTINCT lower(trim(user_email)), day_key, 0
FROM public.events
ON CONFLICT (user_email, day_key) DO NOTHING;

-- Return food rows and their optimistic revision under the same day lock. Two
-- separate REST reads can otherwise observe old rows and a newer revision,
-- allowing the next full-day replacement to overwrite a concurrent commit.
CREATE OR REPLACE FUNCTION public.load_food_day_snapshot(
  p_email TEXT,
  p_day DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_revision BIGINT;
  v_events JSONB;
BEGIN
  IF v_email = '' OR p_day IS NULL THEN
    RAISE EXCEPTION 'food_day_snapshot_account_and_day_required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('day:' || v_email || ':' || p_day::TEXT, 0)
  );

  INSERT INTO public.food_day_revisions (user_email, day_key, revision)
  VALUES (v_email, p_day, 0)
  ON CONFLICT (user_email, day_key) DO NOTHING;

  SELECT revision
    INTO v_revision
    FROM public.food_day_revisions
   WHERE user_email = v_email
     AND day_key = p_day
   FOR UPDATE;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'client_id', e.client_id,
        'title', e.title,
        'payload', e.payload,
        'occurred_at', e.occurred_at,
        'raw_text', e.raw_text
      )
      ORDER BY e.occurred_at ASC, e.created_at ASC, e.id ASC
    ),
    '[]'::JSONB
  )
    INTO v_events
    FROM public.events AS e
   WHERE e.user_email = v_email
     AND e.day_key = p_day
     AND e.category_id = 'food'
     AND e.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'events', v_events,
    'revision', v_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.load_food_day_snapshot(TEXT, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_food_day_snapshot(TEXT, DATE)
  TO service_role;

-- Atomically merge independent profile preference fields. This prevents a
-- theme write and a goal/memory write in two tabs from replacing each other's
-- entire prefs document. Onboarding is shallow-merged and scenes_seen is a
-- bounded set union because those are the two nested/shared structures.
CREATE OR REPLACE FUNCTION public.merge_profile_prefs(
  p_email TEXT,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_current JSONB;
  v_patch JSONB := coalesce(p_patch, '{}'::JSONB);
  v_seen TEXT[] := ARRAY[]::TEXT[];
  v_item TEXT;
  v_count INTEGER;
  v_next JSONB;
BEGIN
  IF v_email = '' OR jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'invalid_profile_preferences' USING ERRCODE = '22023';
  END IF;
  IF octet_length(v_patch::TEXT) > 262144 THEN
    RAISE EXCEPTION 'profile_preferences_too_large' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(prefs, '{}'::JSONB)
    INTO v_current
    FROM public.profiles
   WHERE email = v_email
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(v_current) <> 'object' THEN
    v_current := '{}'::JSONB;
  END IF;

  IF v_patch ? 'onboarding' THEN
    IF jsonb_typeof(v_patch -> 'onboarding') <> 'object' THEN
      RAISE EXCEPTION 'invalid_onboarding_preferences' USING ERRCODE = '22023';
    END IF;
    v_patch := jsonb_set(
      v_patch,
      '{onboarding}',
      CASE
        WHEN jsonb_typeof(v_current -> 'onboarding') = 'object'
          THEN v_current -> 'onboarding'
        ELSE '{}'::JSONB
      END || (v_patch -> 'onboarding'),
      true
    );
  END IF;

  IF v_patch ? 'theme' THEN
    IF jsonb_typeof(v_patch -> 'theme') <> 'object' THEN
      RAISE EXCEPTION 'invalid_theme_preferences' USING ERRCODE = '22023';
    END IF;
    v_patch := jsonb_set(
      v_patch,
      '{theme}',
      CASE
        WHEN jsonb_typeof(v_current -> 'theme') = 'object'
          THEN v_current -> 'theme'
        ELSE '{}'::JSONB
      END || (v_patch -> 'theme'),
      true
    );
  END IF;

  IF v_patch ? 'scenes_seen' THEN
    IF jsonb_typeof(v_patch -> 'scenes_seen') <> 'array' THEN
      RAISE EXCEPTION 'invalid_scenes_seen' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_current -> 'scenes_seen') = 'array' THEN
      FOR v_item IN SELECT value FROM jsonb_array_elements_text(v_current -> 'scenes_seen')
      LOOP
        IF v_item <> '' AND NOT (v_item = ANY(v_seen)) THEN
          v_seen := array_append(v_seen, left(v_item, 40));
        END IF;
      END LOOP;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements_text(v_patch -> 'scenes_seen')
    LOOP
      IF v_item <> '' AND NOT (v_item = ANY(v_seen)) THEN
        v_seen := array_append(v_seen, left(v_item, 40));
      END IF;
    END LOOP;
    v_count := coalesce(cardinality(v_seen), 0);
    IF v_count > 40 THEN
      v_seen := v_seen[(v_count - 39):v_count];
    END IF;
    v_patch := jsonb_set(v_patch, '{scenes_seen}', to_jsonb(v_seen), true);
  END IF;

  v_next := v_current || v_patch;
  UPDATE public.profiles
     SET prefs = v_next,
         updated_at = now()
   WHERE email = v_email;
  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_profile_prefs(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_profile_prefs(TEXT, JSONB)
  TO service_role;

-- Memory needs a same-field mutation, not a stale read followed by replacement.
-- Return an exact removed_count so the assistant cannot claim it forgot a note
-- that never existed.
CREATE OR REPLACE FUNCTION public.mutate_memory_note(
  p_email TEXT,
  p_action TEXT,
  p_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_action TEXT := lower(trim(coalesce(p_action, '')));
  v_text TEXT := left(trim(coalesce(p_text, '')), 240);
  v_prefs JSONB;
  v_notes TEXT[] := ARRAY[]::TEXT[];
  v_next TEXT[] := ARRAY[]::TEXT[];
  v_note TEXT;
  v_count INTEGER;
  v_removed INTEGER := 0;
  v_changed BOOLEAN := false;
BEGIN
  IF v_email = '' OR v_text = '' OR v_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'invalid_memory_mutation' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(prefs, '{}'::JSONB)
    INTO v_prefs
    FROM public.profiles
   WHERE email = v_email
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(v_prefs) <> 'object' THEN
    v_prefs := '{}'::JSONB;
  END IF;

  IF jsonb_typeof(v_prefs -> 'memory_notes') = 'array' THEN
    FOR v_note IN SELECT value FROM jsonb_array_elements_text(v_prefs -> 'memory_notes')
    LOOP
      IF trim(v_note) <> '' THEN
        v_notes := array_append(v_notes, left(trim(v_note), 240));
      END IF;
    END LOOP;
  END IF;

  FOREACH v_note IN ARRAY v_notes
  LOOP
    IF v_action = 'add' AND lower(v_note) = lower(v_text) THEN
      CONTINUE;
    END IF;
    IF v_action = 'remove' AND position(lower(v_text) IN lower(v_note)) > 0 THEN
      v_removed := v_removed + 1;
      CONTINUE;
    END IF;
    v_next := array_append(v_next, v_note);
  END LOOP;

  IF v_action = 'add' THEN
    v_next := array_append(v_next, v_text);
  END IF;
  v_count := coalesce(cardinality(v_next), 0);
  IF v_count > 40 THEN
    v_next := v_next[(v_count - 39):v_count];
  END IF;

  v_changed := v_next IS DISTINCT FROM v_notes;

  IF v_changed THEN
    v_prefs := jsonb_set(v_prefs, '{memory_notes}', to_jsonb(v_next), true);
    UPDATE public.profiles
       SET prefs = v_prefs,
           updated_at = now()
     WHERE email = v_email;
  END IF;

  RETURN jsonb_build_object(
    'notes', to_jsonb(v_next),
    'changed', v_changed,
    'removed_count', v_removed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mutate_memory_note(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_memory_note(TEXT, TEXT, TEXT)
  TO service_role;

-- Pre-call quota reservations put a hard server-side ceiling in front of paid
-- model requests. Usage logging after the provider responds is too late to
-- stop concurrent scripted spend.
CREATE TABLE IF NOT EXISTS public.llm_quota_state (
  user_email TEXT PRIMARY KEY REFERENCES public.profiles(email) ON DELETE CASCADE,
  day_key DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::DATE,
  day_requests INTEGER NOT NULL DEFAULT 0 CHECK (day_requests >= 0),
  day_reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (day_reserved_tokens >= 0),
  minute_bucket TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now()),
  minute_requests INTEGER NOT NULL DEFAULT 0 CHECK (minute_requests >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.llm_quota_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.llm_quota_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.llm_quota_state TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_llm_turn(
  p_email TEXT,
  p_reserved_tokens INTEGER,
  p_minute_limit INTEGER,
  p_daily_request_limit INTEGER,
  p_daily_token_budget BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_today DATE := (now() AT TIME ZONE 'UTC')::DATE;
  v_minute TIMESTAMPTZ := date_trunc('minute', now());
  v_state public.llm_quota_state%ROWTYPE;
BEGIN
  IF v_email = ''
     OR p_reserved_tokens < 1 OR p_reserved_tokens > 100000
     OR p_minute_limit < 1 OR p_minute_limit > 120
     OR p_daily_request_limit < 1 OR p_daily_request_limit > 5000
     OR p_daily_token_budget < 1000 OR p_daily_token_budget > 1000000000 THEN
    RAISE EXCEPTION 'invalid_llm_quota' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('llm-quota:' || v_email, 0));
  INSERT INTO public.llm_quota_state (user_email)
  VALUES (v_email)
  ON CONFLICT (user_email) DO NOTHING;

  SELECT * INTO v_state
    FROM public.llm_quota_state
   WHERE user_email = v_email
   FOR UPDATE;

  IF v_state.day_key <> v_today THEN
    v_state.day_key := v_today;
    v_state.day_requests := 0;
    v_state.day_reserved_tokens := 0;
  END IF;
  IF v_state.minute_bucket <> v_minute THEN
    v_state.minute_bucket := v_minute;
    v_state.minute_requests := 0;
  END IF;

  IF v_state.minute_requests >= p_minute_limit THEN
    RAISE EXCEPTION 'llm_minute_limit_reached' USING ERRCODE = 'P0001';
  END IF;
  IF v_state.day_requests >= p_daily_request_limit
     OR v_state.day_reserved_tokens + p_reserved_tokens > p_daily_token_budget THEN
    RAISE EXCEPTION 'llm_daily_limit_reached' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.llm_quota_state
     SET day_key = v_state.day_key,
         day_requests = v_state.day_requests + 1,
         day_reserved_tokens = v_state.day_reserved_tokens + p_reserved_tokens,
         minute_bucket = v_state.minute_bucket,
         minute_requests = v_state.minute_requests + 1,
         updated_at = now()
   WHERE user_email = v_email
  RETURNING * INTO v_state;

  RETURN jsonb_build_object(
    'ok', true,
    'day_requests', v_state.day_requests,
    'day_reserved_tokens', v_state.day_reserved_tokens,
    'minute_requests', v_state.minute_requests
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_llm_turn(TEXT, INTEGER, INTEGER, INTEGER, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_llm_turn(TEXT, INTEGER, INTEGER, INTEGER, BIGINT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.sync_food_day_atomic(
  p_email TEXT,
  p_day DATE,
  p_rows JSONB,
  p_expected_revision BIGINT,
  p_raw_text TEXT DEFAULT NULL,
  p_allow_clear BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_row JSONB;
  v_measure JSONB;
  v_client_id TEXT;
  v_title TEXT;
  v_payload JSONB;
  v_measures JSONB;
  v_event_id UUID;
  v_measure_id TEXT;
  v_measure_value DOUBLE PRECISION;
  v_measure_unit TEXT;
  v_seen_client_ids TEXT[] := ARRAY[]::TEXT[];
  v_seen_measure_ids TEXT[] := ARRAY[]::TEXT[];
  v_count INTEGER := 0;
  v_current_revision BIGINT;
  v_next_revision BIGINT;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'email_required' USING ERRCODE = '22023';
  END IF;
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'day_required' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_array_required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'too_many_food_rows' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_rows::TEXT) > 2000000 THEN
    RAISE EXCEPTION 'food_day_payload_too_large' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'food_day_revision_required' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_raw_text, '')) > 4000 THEN
    RAISE EXCEPTION 'raw_text_too_long' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) = 0 AND p_allow_clear IS NOT TRUE THEN
    RAISE EXCEPTION 'explicit_clear_required' USING ERRCODE = '22023';
  END IF;

  -- Serialize full replacements for this account/day. Any error below aborts
  -- the function and PostgreSQL rolls every delete/update/insert back.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('day:' || v_email || ':' || p_day::TEXT, 0)
  );

  INSERT INTO public.food_day_revisions (user_email, day_key, revision)
  VALUES (v_email, p_day, 0)
  ON CONFLICT (user_email, day_key) DO NOTHING;

  SELECT revision
    INTO v_current_revision
    FROM public.food_day_revisions
   WHERE user_email = v_email
     AND day_key = p_day
   FOR UPDATE;

  IF v_current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale_food_day_revision'
      USING ERRCODE = '40001',
            DETAIL = 'Reload the day before changing it.';
  END IF;

  UPDATE public.events
     SET deleted_at = now()
   WHERE user_email = v_email
     AND day_key = p_day
     AND category_id = 'food'
     AND deleted_at IS NULL;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'invalid_food_row' USING ERRCODE = '22023';
    END IF;

    v_client_id := left(
      trim(coalesce(v_row ->> 'client_id', v_row ->> 'id', '')),
      200
    );
    IF v_client_id = '' THEN
      RAISE EXCEPTION 'food_row_id_required' USING ERRCODE = '22023';
    END IF;
    IF v_client_id = ANY(v_seen_client_ids) THEN
      RAISE EXCEPTION 'duplicate_food_row_id' USING ERRCODE = '22023';
    END IF;
    v_seen_client_ids := array_append(v_seen_client_ids, v_client_id);

    v_title := left(coalesce(nullif(trim(v_row ->> 'title'), ''), 'Food'), 300);
    v_payload := coalesce(v_row -> 'payload', '{}'::JSONB);
    v_measures := coalesce(v_row -> 'measures', '[]'::JSONB);
    IF jsonb_typeof(v_payload) <> 'object' OR jsonb_typeof(v_measures) <> 'array' THEN
      RAISE EXCEPTION 'invalid_food_row_shape' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_measures) > 150 THEN
      RAISE EXCEPTION 'too_many_food_measures' USING ERRCODE = '22023';
    END IF;
    IF octet_length(v_payload::TEXT) > 65536
       OR octet_length(v_measures::TEXT) > 65536 THEN
      RAISE EXCEPTION 'food_row_payload_too_large' USING ERRCODE = '22023';
    END IF;
    v_seen_measure_ids := ARRAY[]::TEXT[];

    SELECT id
      INTO v_event_id
      FROM public.events
     WHERE user_email = v_email
       AND day_key = p_day
       AND category_id = 'food'
       AND client_id = v_client_id
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE;

    IF v_event_id IS NULL THEN
      INSERT INTO public.events (
        user_email,
        category_id,
        day_key,
        title,
        raw_text,
        source,
        payload,
        client_id,
        occurred_at,
        deleted_at
      )
      VALUES (
        v_email,
        'food',
        p_day,
        v_title,
        p_raw_text,
        'chat',
        v_payload,
        v_client_id,
        coalesce(nullif(v_row ->> 'occurred_at', '')::TIMESTAMPTZ, now()),
        NULL
      )
      RETURNING id INTO v_event_id;
    ELSE
      UPDATE public.events
         SET title = v_title,
             raw_text = p_raw_text,
             source = 'chat',
             payload = v_payload,
             occurred_at = coalesce(
               nullif(v_row ->> 'occurred_at', '')::TIMESTAMPTZ,
               occurred_at
             ),
             deleted_at = NULL
       WHERE id = v_event_id;
    END IF;

    DELETE FROM public.event_measures WHERE event_id = v_event_id;

    FOR v_measure IN SELECT value FROM jsonb_array_elements(v_measures)
    LOOP
      IF jsonb_typeof(v_measure) <> 'object' THEN
        RAISE EXCEPTION 'invalid_food_measure' USING ERRCODE = '22023';
      END IF;
      v_measure_id := lower(
        regexp_replace(trim(coalesce(v_measure ->> 'measure_id', '')), '[^a-zA-Z0-9_]+', '_', 'g')
      );
      IF v_measure_id = '' OR length(v_measure_id) > 80 THEN
        RAISE EXCEPTION 'invalid_measure_id' USING ERRCODE = '22023';
      END IF;
      IF v_measure_id = ANY(v_seen_measure_ids) THEN
        RAISE EXCEPTION 'duplicate_measure_id' USING ERRCODE = '22023';
      END IF;
      v_seen_measure_ids := array_append(v_seen_measure_ids, v_measure_id);
      BEGIN
        v_measure_value := (v_measure ->> 'value')::DOUBLE PRECISION;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid_measure_value' USING ERRCODE = '22023';
      END;
      IF jsonb_typeof(v_measure -> 'value') <> 'number'
         OR v_measure_value::TEXT IN ('NaN', 'Infinity', '-Infinity')
         OR v_measure_value < 0
         OR v_measure_value > 1000000000 THEN
        RAISE EXCEPTION 'invalid_food_measure_value' USING ERRCODE = '22023';
      END IF;
      v_measure_unit := left(coalesce(v_measure ->> 'unit', ''), 32);

      INSERT INTO public.measures (id, label, unit, group_name)
      VALUES (
        v_measure_id,
        replace(v_measure_id, '_', ' '),
        v_measure_unit,
        'other'
      )
      ON CONFLICT (id) DO UPDATE
        SET unit = CASE
          WHEN EXCLUDED.unit <> '' THEN EXCLUDED.unit
          ELSE public.measures.unit
        END;

      INSERT INTO public.event_measures (
        event_id,
        user_email,
        day_key,
        measure_id,
        value,
        unit
      )
      VALUES (
        v_event_id,
        v_email,
        p_day,
        v_measure_id,
        v_measure_value,
        v_measure_unit
      );
    END LOOP;

    v_count := v_count + 1;
    v_event_id := NULL;
  END LOOP;

  PERFORM public.recompute_day_totals(v_email, p_day);

  UPDATE public.food_day_revisions
     SET revision = revision + 1,
         updated_at = now()
   WHERE user_email = v_email
     AND day_key = p_day
  RETURNING revision INTO v_next_revision;

  RETURN jsonb_build_object(
    'ok', true,
    'day', p_day,
    'count', v_count,
    'revision', v_next_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_food_day_atomic(TEXT, DATE, JSONB, BIGINT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_food_day_atomic(TEXT, DATE, JSONB, BIGINT, TEXT, BOOLEAN)
  TO service_role;

-- Old REST writes could create more than one active non-food event with the
-- same account/client ID. Deactivate only the extra active copies, recompute
-- their affected days, then enforce one active retry target going forward.
-- The short table lock closes the cleanup-to-index race with the old API.
LOCK TABLE public.events IN SHARE ROW EXCLUSIVE MODE;

DO $cleanup_nonfood_duplicates$
DECLARE
  v_duplicate RECORD;
BEGIN
  FOR v_duplicate IN
    WITH ranked AS (
      SELECT
        e.id,
        e.user_email,
        e.day_key,
        row_number() OVER (
          PARTITION BY e.user_email, e.client_id
          ORDER BY (e.deleted_at IS NULL) DESC, e.created_at ASC, e.id ASC
        ) AS duplicate_rank
      FROM public.events AS e
      WHERE e.client_id IS NOT NULL
        AND e.category_id <> 'food'
    )
    SELECT id, user_email, day_key
    FROM ranked
    WHERE duplicate_rank > 1
  LOOP
    UPDATE public.events
       SET deleted_at = coalesce(deleted_at, now())
     WHERE id = v_duplicate.id
       AND deleted_at IS NULL;

    IF FOUND THEN
      PERFORM public.recompute_day_totals(
        v_duplicate.user_email,
        v_duplicate.day_key
      );
    END IF;
  END LOOP;
END;
$cleanup_nonfood_duplicates$;

CREATE UNIQUE INDEX IF NOT EXISTS events_active_nonfood_client_unique_idx
  ON public.events (user_email, client_id)
  WHERE client_id IS NOT NULL
    AND deleted_at IS NULL
    AND category_id <> 'food';

-- Upsert one exercise/steps/body/custom event and all of its measures in one
-- transaction. The account + client ID lock makes retries idempotent without
-- collapsing two legitimate events that have different client IDs.
CREATE OR REPLACE FUNCTION public.log_event_atomic(
  p_email TEXT,
  p_category_id TEXT,
  p_category_label TEXT,
  p_category_kind TEXT,
  p_title TEXT,
  p_raw_text TEXT,
  p_day DATE,
  p_occurred_at TIMESTAMPTZ,
  p_payload JSONB,
  p_measures JSONB,
  p_client_id TEXT,
  p_source TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_category_id TEXT := lower(trim(coalesce(p_category_id, '')));
  v_category_label TEXT := trim(coalesce(p_category_label, ''));
  v_category_kind TEXT := lower(trim(coalesce(p_category_kind, 'custom')));
  v_title TEXT := trim(coalesce(p_title, ''));
  v_client_id TEXT := trim(coalesce(p_client_id, ''));
  v_source TEXT := lower(trim(coalesce(p_source, 'chat')));
  v_event_id UUID;
  v_previous_day DATE;
  v_created BOOLEAN := false;
  v_measure JSONB;
  v_measure_id TEXT;
  v_measure_label TEXT;
  v_measure_value DOUBLE PRECISION;
  v_measure_unit TEXT;
  v_measure_group TEXT;
  v_seen_measure_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_email = ''
     OR length(v_email) > 320
     OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid_event_account' USING ERRCODE = '22023';
  END IF;
  IF v_category_id = ''
     OR length(v_category_id) > 80
     OR v_category_id !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid_event_category' USING ERRCODE = '22023';
  END IF;
  IF lower(trim(p_category_id)) = 'food' THEN
    RAISE EXCEPTION 'food_requires_food_ledger' USING ERRCODE = '22023';
  END IF;
  IF length(v_category_label) > 120 THEN
    RAISE EXCEPTION 'event_category_label_too_long' USING ERRCODE = '22023';
  END IF;
  IF v_category_label = '' THEN
    v_category_label := initcap(replace(v_category_id, '_', ' '));
  END IF;
  IF v_category_kind = ''
     OR length(v_category_kind) > 32
     OR v_category_kind !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid_event_kind' USING ERRCODE = '22023';
  END IF;
  IF length(v_title) > 300 THEN
    RAISE EXCEPTION 'event_title_too_long' USING ERRCODE = '22023';
  END IF;
  IF v_title = '' THEN
    v_title := v_category_label;
  END IF;
  IF p_raw_text IS NOT NULL AND length(p_raw_text) > 4000 THEN
    RAISE EXCEPTION 'event_raw_text_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_day IS NULL OR p_day < DATE '1900-01-01' OR p_day > DATE '2200-12-31' THEN
    RAISE EXCEPTION 'invalid_event_day' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NOT NULL
     AND (
       p_occurred_at < TIMESTAMPTZ '1900-01-01 00:00:00+00'
       OR p_occurred_at >= TIMESTAMPTZ '2201-01-01 00:00:00+00'
     ) THEN
    RAISE EXCEPTION 'invalid_event_timestamp' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_event_payload' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_payload::TEXT) > 65536 THEN
    RAISE EXCEPTION 'event_payload_too_large' USING ERRCODE = '22023';
  END IF;
  IF p_measures IS NULL OR jsonb_typeof(p_measures) <> 'array' THEN
    RAISE EXCEPTION 'invalid_event_measures' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_measures) > 100 THEN
    RAISE EXCEPTION 'too_many_event_measures' USING ERRCODE = '22023';
  END IF;
  IF v_client_id = '' OR length(v_client_id) > 200 THEN
    RAISE EXCEPTION 'invalid_event_client_id' USING ERRCODE = '22023';
  END IF;
  IF v_source = '' OR length(v_source) > 32 OR v_source !~ '^[a-z0-9_-]+$' THEN
    RAISE EXCEPTION 'invalid_event_source' USING ERRCODE = '22023';
  END IF;

  -- A transaction-level lock is automatically released on commit/rollback.
  -- Including the normalized account prevents one tenant from blocking or
  -- updating another tenant's event with the same client-generated ID.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('event:' || v_email || ':' || v_client_id, 0)
  );

  INSERT INTO public.categories (id, label, kind)
  VALUES (v_category_id, v_category_label, v_category_kind)
  ON CONFLICT (id) DO NOTHING;

  SELECT e.id, e.day_key
    INTO v_event_id, v_previous_day
    FROM public.events AS e
   WHERE e.user_email = v_email
     AND e.client_id = v_client_id
     AND e.category_id <> 'food'
   ORDER BY (e.deleted_at IS NULL) DESC, e.created_at ASC, e.id ASC
   LIMIT 1
   FOR UPDATE;

  -- Daily rollups are shared by every event on an account/day, so event-level
  -- locking alone is insufficient. Lock both affected days in date order to
  -- prevent rollup races and cross-day move deadlocks. Food replacement uses
  -- the same day-lock namespace above.
  IF v_previous_day IS NULL OR v_previous_day = p_day THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('day:' || v_email || ':' || p_day::TEXT, 0)
    );
  ELSIF v_previous_day < p_day THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('day:' || v_email || ':' || v_previous_day::TEXT, 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('day:' || v_email || ':' || p_day::TEXT, 0)
    );
  ELSE
    PERFORM pg_advisory_xact_lock(
      hashtextextended('day:' || v_email || ':' || p_day::TEXT, 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('day:' || v_email || ':' || v_previous_day::TEXT, 0)
    );
  END IF;

  IF v_event_id IS NULL THEN
    INSERT INTO public.events (
      user_email,
      category_id,
      day_key,
      title,
      raw_text,
      source,
      payload,
      client_id,
      occurred_at,
      deleted_at
    )
    VALUES (
      v_email,
      v_category_id,
      p_day,
      v_title,
      p_raw_text,
      v_source,
      p_payload,
      v_client_id,
      coalesce(p_occurred_at, now()),
      NULL
    )
    RETURNING id INTO v_event_id;
    v_created := true;
  ELSE
    UPDATE public.events
       SET category_id = v_category_id,
           day_key = p_day,
           title = v_title,
           raw_text = p_raw_text,
           source = v_source,
           payload = p_payload,
           occurred_at = coalesce(p_occurred_at, occurred_at),
           deleted_at = NULL
     WHERE id = v_event_id
       AND user_email = v_email;
  END IF;

  DELETE FROM public.event_measures
   WHERE event_id = v_event_id
     AND user_email = v_email;

  FOR v_measure IN SELECT value FROM jsonb_array_elements(p_measures)
  LOOP
    IF jsonb_typeof(v_measure) <> 'object' THEN
      RAISE EXCEPTION 'invalid_event_measure' USING ERRCODE = '22023';
    END IF;

    v_measure_id := lower(trim(coalesce(v_measure ->> 'measure_id', '')));
    IF v_measure_id = ''
       OR length(v_measure_id) > 80
       OR v_measure_id !~ '^[a-z0-9_]+$' THEN
      RAISE EXCEPTION 'invalid_measure_id' USING ERRCODE = '22023';
    END IF;
    IF v_measure_id = ANY(v_seen_measure_ids) THEN
      RAISE EXCEPTION 'duplicate_measure_id' USING ERRCODE = '22023';
    END IF;
    v_seen_measure_ids := array_append(v_seen_measure_ids, v_measure_id);

    IF jsonb_typeof(v_measure -> 'value') <> 'number' THEN
      RAISE EXCEPTION 'invalid_measure_value' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_measure_value := (v_measure ->> 'value')::DOUBLE PRECISION;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_measure_value' USING ERRCODE = '22023';
    END;
    IF v_measure_value::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR abs(v_measure_value) > 1000000000000 THEN
      RAISE EXCEPTION 'invalid_measure_value' USING ERRCODE = '22023';
    END IF;

    v_measure_label := trim(coalesce(v_measure ->> 'label', ''));
    IF length(v_measure_label) > 120 THEN
      RAISE EXCEPTION 'measure_label_too_long' USING ERRCODE = '22023';
    END IF;
    IF v_measure_label = '' THEN
      v_measure_label := initcap(replace(v_measure_id, '_', ' '));
    END IF;
    v_measure_unit := coalesce(v_measure ->> 'unit', '');
    IF length(v_measure_unit) > 32 THEN
      RAISE EXCEPTION 'measure_unit_too_long' USING ERRCODE = '22023';
    END IF;
    v_measure_group := lower(trim(coalesce(v_measure ->> 'group', 'other')));
    IF v_measure_group = ''
       OR length(v_measure_group) > 32
       OR v_measure_group !~ '^[a-z0-9_]+$' THEN
      RAISE EXCEPTION 'invalid_measure_group' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.measures (id, label, unit, group_name)
    VALUES (v_measure_id, v_measure_label, v_measure_unit, v_measure_group)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.event_measures (
      event_id,
      user_email,
      day_key,
      measure_id,
      value,
      unit
    )
    VALUES (
      v_event_id,
      v_email,
      p_day,
      v_measure_id,
      v_measure_value,
      v_measure_unit
    );
  END LOOP;

  PERFORM public.recompute_day_totals(v_email, p_day);
  IF v_previous_day IS NOT NULL AND v_previous_day <> p_day THEN
    PERFORM public.recompute_day_totals(v_email, v_previous_day);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'day', p_day,
    'client_id', v_client_id,
    'created', v_created,
    'measure_count', jsonb_array_length(p_measures)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_event_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_event_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB, JSONB, TEXT, TEXT
) TO service_role;

-- The old recompute helper could fail before this migration, leaving the
-- materialized totals empty even though event measures existed. Repair every
-- historical ledger day once as part of the migration.
DO $backfill_day_totals$
DECLARE
  v_day RECORD;
BEGIN
  FOR v_day IN
    SELECT DISTINCT user_email, day_key
    FROM public.events
  LOOP
    PERFORM public.recompute_day_totals(v_day.user_email, v_day.day_key);
  END LOOP;
END;
$backfill_day_totals$;

COMMIT;
