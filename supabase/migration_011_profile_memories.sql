-- Transparent, account-scoped permanent memory.
-- Explicit user facts/preferences are durable records with stable identity and
-- provenance. Inference is reserved for a later evidence/review system.

CREATE TABLE IF NOT EXISTS public.profile_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES public.profiles(email) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fact'
    CHECK (kind IN ('fact', 'preference', 'inference')),
  text TEXT NOT NULL
    CHECK (char_length(btrim(text)) BETWEEN 1 AND 300),
  provenance TEXT NOT NULL DEFAULT 'user_ui'
    CHECK (provenance IN ('user_chat', 'user_ui', 'legacy', 'inferred')),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1
    CHECK (confidence >= 0 AND confidence <= 1),
  source_conversation_id UUID REFERENCES public.chat_conversations(id) ON DELETE SET NULL,
  source_message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_memories_user_updated_idx
  ON public.profile_memories (user_email, updated_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS profile_memories_user_text_unique_idx
  ON public.profile_memories (user_email, lower(btrim(text)));

-- Keep the migration self-contained even when a project was assembled from
-- incremental migrations instead of the full schema file.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_memories_touch ON public.profile_memories;
CREATE TRIGGER profile_memories_touch
  BEFORE UPDATE ON public.profile_memories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Serialize inserts per account and keep the bounded prompt/UI contract true
-- even if two requests arrive at the same time or bypass the API preflight.
CREATE OR REPLACE FUNCTION public.enforce_profile_memory_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_email, 0));
  IF EXISTS (
    SELECT 1
    FROM public.profile_memories
    WHERE user_email = NEW.user_email
      AND lower(btrim(text)) = lower(btrim(NEW.text))
  ) THEN
    RETURN NEW;
  END IF;
  IF (SELECT count(*) FROM public.profile_memories WHERE user_email = NEW.user_email) >= 40 THEN
    IF NEW.provenance = 'legacy' THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'profile_memory_limit';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_profile_memory_limit() FROM PUBLIC;
DROP TRIGGER IF EXISTS profile_memories_limit ON public.profile_memories;
CREATE TRIGGER profile_memories_limit
  BEFORE INSERT ON public.profile_memories
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_memory_limit();

ALTER TABLE public.profile_memories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profile_memories FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profile_memories TO service_role;

-- One-time compatibility backfill. The old JSON list remains untouched for a
-- release so rollback can still read it. Exact duplicates are ignored.
INSERT INTO public.profile_memories (
  user_email,
  kind,
  text,
  provenance,
  confidence,
  created_at,
  updated_at
)
SELECT
  p.email,
  'fact',
  left(btrim(note.value), 300),
  'legacy',
  1,
  coalesce(p.updated_at, p.created_at, now()),
  coalesce(p.updated_at, p.created_at, now())
FROM public.profiles p
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof(p.prefs -> 'memory_notes') = 'array'
      THEN p.prefs -> 'memory_notes'
    ELSE '[]'::JSONB
  END
) WITH ORDINALITY AS note(value, ordinal)
WHERE btrim(note.value) <> ''
  AND note.ordinal <= 40
ON CONFLICT DO NOTHING;
