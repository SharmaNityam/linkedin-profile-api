-- Pending signups become per-submission rather than per-address.
--
-- Before this, an unverified signup was a `users` row and a repeat signup
-- overwrote its password hash, so the last submission before verification won:
-- an attacker who signed up after the victim owned the account the moment the
-- victim verified with their own code. Now every submission is its own row and
-- verification creates the account from the row whose code was presented, so a
-- code can only ever unlock the password it was mailed with.

create table if not exists pending_signups (
  id              uuid primary key default gen_random_uuid(),
  -- The address as typed (what the code was mailed to) and the de-duplicated
  -- form every lookup matches on. Not unique: one address may have several
  -- submissions in flight, and each keeps its own password and code.
  email           text        not null,
  email_canonical text        not null,
  password_hash   text        not null,
  code_hash       text        not null,
  expires_at      timestamptz not null,
  attempts        integer     not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists pending_signups_email_canonical_idx
  on pending_signups (email_canonical);

drop table if exists email_verifications;

-- A `users` row now means a verified account, nothing else. Every environment
-- so far has an empty table, but backfill defensively rather than fail the
-- migration on a row nobody expected.
update users set email_verified_at = created_at where email_verified_at is null;
alter table users alter column email_verified_at set not null;
