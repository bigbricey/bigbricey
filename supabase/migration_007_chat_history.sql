-- Multi-conversation chat history for BigBricey. Older installations used one
-- flat chat_messages table, so preserve and import those rows before creating
-- the conversation-scoped table.
BEGIN;

DO $upgrade_legacy_chat_messages$
BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.chat_messages'::regclass
         AND attname = 'conversation_id'
         AND NOT attisdropped
     ) THEN
    IF to_regclass('public.chat_messages_legacy_007') IS NOT NULL THEN
      RAISE EXCEPTION 'chat_messages_legacy_007 already exists; refusing to overwrite it';
    END IF;
    ALTER TABLE public.chat_messages RENAME TO chat_messages_legacy_007;
  END IF;
END;
$upgrade_legacy_chat_messages$;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Chat',
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_conversations_user_updated_idx
  ON chat_conversations (user_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_conv_created_idx
  ON chat_messages (conversation_id, created_at ASC);

-- Put each account's legacy transcript in one clearly labelled conversation.
-- The old table remains as a backup; ON CONFLICT makes the copy safe if a
-- partially completed manual install is retried inside a new transaction.
DO $import_legacy_chat_messages$
DECLARE
  v_user RECORD;
  v_conversation_id UUID;
BEGIN
  IF to_regclass('public.chat_messages_legacy_007') IS NULL THEN
    RETURN;
  END IF;

  FOR v_user IN
    SELECT
      legacy.user_email,
      min(legacy.created_at) AS first_message_at,
      max(legacy.created_at) AS last_message_at
    FROM public.chat_messages_legacy_007 AS legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.chat_messages AS current_message
      WHERE current_message.id = legacy.id
    )
    GROUP BY legacy.user_email
  LOOP
    INSERT INTO public.chat_conversations (
      user_email,
      title,
      created_at,
      updated_at
    )
    VALUES (
      v_user.user_email,
      'Imported chat history',
      v_user.first_message_at,
      v_user.last_message_at
    )
    RETURNING id INTO v_conversation_id;

    INSERT INTO public.chat_messages (
      id,
      conversation_id,
      user_email,
      role,
      content,
      created_at
    )
    SELECT
      legacy.id,
      v_conversation_id,
      legacy.user_email,
      CASE
        WHEN legacy.role IN ('user', 'assistant', 'system') THEN legacy.role
        ELSE 'system'
      END,
      legacy.content,
      legacy.created_at
    FROM public.chat_messages_legacy_007 AS legacy
    WHERE legacy.user_email = v_user.user_email
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
END;
$import_legacy_chat_messages$;

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.chat_conversations, public.chat_messages
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.chat_conversations, public.chat_messages
  TO service_role;

COMMIT;
