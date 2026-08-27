-- Accounts, email verification codes and cached phone-validation verdicts.
-- gen_random_uuid() is built in from Postgres 13 on, so no extension is needed.

create table if not exists schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  -- The address as the user typed it (for display and for sending mail);
  -- email_canonical is the de-duplicated form everything matches on.
  email             text        not null,
  email_canonical   text        not null unique,
  email_verified_at timestamptz,
  password_hash     text        not null,
  phone_e164        text unique,
  phone_verified_at timestamptz,
  -- Bumped to invalidate every session already issued to this user.
  session_version   integer     not null default 0,
  created_at        timestamptz not null default now()
);

-- At most one pending code per user; re-issuing replaces the previous row.
create table if not exists email_verifications (
  user_id    uuid primary key references users (id) on delete cascade,
  code_hash  text        not null,
  expires_at timestamptz not null,
  attempts   integer     not null default 0
);

-- A cache of provider verdicts, so re-checking a number costs nothing.
create table if not exists phone_validations (
  phone_e164 text primary key,
  provider   text        not null,
  valid      boolean,
  type       text,
  raw        jsonb,
  checked_at timestamptz not null default now()
);
