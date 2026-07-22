-- Health Snapshot metric semantics.
--
-- Additive measures such as nutrients, steps, and workout duration are daily
-- totals. Body-state readings such as weight and blood pressure are not: when
-- more than one reading exists on a day, the latest active reading is the
-- authoritative value for that day. Keep that rule inside the bounded database
-- read service so every report/export consumer receives the same answer.

BEGIN;

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

  WITH state_measure_ids(measure_id) AS (
    VALUES
      ('weight_lb'::TEXT),
      ('body_fat_pct'::TEXT),
      ('waist_in'::TEXT),
      ('hip_in'::TEXT),
      ('chest_in'::TEXT),
      ('neck_in'::TEXT),
      ('glucose_mg_dl'::TEXT),
      ('blood_pressure_systolic'::TEXT),
      ('blood_pressure_diastolic'::TEXT),
      ('resting_heart_rate'::TEXT),
      ('temperature_f'::TEXT)
  ),
  latest_state_totals AS (
    SELECT ranked.day_key, ranked.measure_id, ranked.value AS total, ranked.unit
    FROM (
      SELECT
        em.day_key,
        em.measure_id,
        em.value,
        em.unit,
        row_number() OVER (
          PARTITION BY em.day_key, em.measure_id
          ORDER BY e.occurred_at DESC, em.created_at DESC, em.id DESC
        ) AS reading_rank
      FROM public.event_measures AS em
      JOIN public.events AS e
        ON e.id = em.event_id
       AND e.account_id = em.account_id
      WHERE em.account_id = p_account_id
        AND e.account_id = p_account_id
        AND e.deleted_at IS NULL
        AND em.day_key BETWEEN p_from AND p_to
        AND em.measure_id IN (SELECT measure_id FROM state_measure_ids)
        AND em.value::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
    ) AS ranked
    WHERE ranked.reading_rank = 1
  ),
  scoped_totals AS (
    SELECT dt.day_key, dt.measure_id, dt.total, dt.unit
    FROM public.day_totals AS dt
    WHERE dt.account_id = p_account_id
      AND dt.day_key BETWEEN p_from AND p_to
      AND dt.total::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
      AND dt.measure_id NOT IN (SELECT measure_id FROM state_measure_ids)
    UNION ALL
    SELECT day_key, measure_id, total, unit
    FROM latest_state_totals
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

COMMIT;
