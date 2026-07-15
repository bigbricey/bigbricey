-- Reserve capacity for an additional provider pass without counting a second
-- user request. The initial turn still owns request/minute throttling through
-- reserve_llm_turn; this function only extends that turn's token ceiling.
CREATE OR REPLACE FUNCTION public.reserve_llm_tokens(
  p_email TEXT,
  p_reserved_tokens INTEGER,
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
  v_state public.llm_quota_state%ROWTYPE;
BEGIN
  IF v_email = ''
     OR p_reserved_tokens < 1 OR p_reserved_tokens > 100000
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

  IF v_state.day_reserved_tokens + p_reserved_tokens > p_daily_token_budget THEN
    RAISE EXCEPTION 'llm_daily_limit_reached' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.llm_quota_state
     SET day_key = v_state.day_key,
         day_requests = v_state.day_requests,
         day_reserved_tokens = v_state.day_reserved_tokens + p_reserved_tokens,
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

REVOKE ALL ON FUNCTION public.reserve_llm_tokens(TEXT, INTEGER, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_llm_tokens(TEXT, INTEGER, BIGINT)
  TO service_role;
