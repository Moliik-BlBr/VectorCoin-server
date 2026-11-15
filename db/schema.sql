CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('teacher','participant','admin')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_token text;
ALTER TABLE users ALTER COLUMN qr_token SET DEFAULT encode(gen_random_bytes(24),'hex');
UPDATE users SET qr_token=encode(gen_random_bytes(24),'hex') WHERE qr_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_qr_token ON users(qr_token);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','upcoming','closed')),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='events_name_key') THEN
    ALTER TABLE events DROP CONSTRAINT events_name_key;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_events_status_created ON events(status,created_at DESC);

CREATE TABLE IF NOT EXISTS event_teachers (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(event_id,teacher_id)
);
CREATE TABLE IF NOT EXISTS event_participants (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,user_id)
);
ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0);

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  class_name text NOT NULL DEFAULT '',
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_open boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,name)
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id,user_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  team_id uuid REFERENCES teams(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  sender_user_id uuid REFERENCES users(id),
  recipient_user_id uuid REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'manual',
  transaction_type text NOT NULL DEFAULT 'team_credit',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE transactions ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sender_user_id uuid REFERENCES users(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_user_id uuid REFERENCES users(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_method_check;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_method_check CHECK (method IN ('manual','qr','transfer','group','nfc'));
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check CHECK (transaction_type IN ('team_credit','participant_credit','teacher_credit','teacher_debit','transfer'));
CREATE INDEX IF NOT EXISTS idx_transactions_event_created ON transactions(event_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_recipient ON transactions(recipient_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_participants_user ON event_participants(user_id);

-- One-time migration of the previous global wallet into the legacy test event.
CREATE TABLE IF NOT EXISTS app_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
DO $$
DECLARE test_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE version='event-wallets-v1') THEN
    SELECT id INTO test_id FROM events WHERE lower(name)='test' ORDER BY created_at LIMIT 1;
    IF test_id IS NOT NULL THEN
      UPDATE event_participants ep SET balance=u.balance
      FROM users u WHERE ep.user_id=u.id AND ep.event_id=test_id AND ep.balance=0 AND u.balance>0;
    END IF;
    INSERT INTO app_migrations(version) VALUES('event-wallets-v1') ON CONFLICT DO NOTHING;
  END IF;
END $$;
