-- Keep row-level mutation auditing without blocking an authorized account
-- deletion. During ON DELETE CASCADE PostgreSQL has already made the parent
-- account unavailable, so a child DELETE audit row cannot satisfy its account
-- foreign key. Direct child deletions still audit normally while the account
-- exists; cascade cleanup skips only the impossible-to-retain audit row.

BEGIN;

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

  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.accounts AS account
    WHERE account.id = v_account_id
  ) THEN
    RETURN OLD;
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
GRANT EXECUTE ON FUNCTION public.audit_account_mutation()
  TO service_role;

COMMIT;
