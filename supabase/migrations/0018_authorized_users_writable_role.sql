-- 0018: grant a writeable role to authorized (whitelisted) users.
--
-- Root cause ("Save failed / forbidden" on every save): syncCurrentUser() upserts
-- identity only, so every newly-onboarded @yourcompany.example user landed on
-- the column default role 'viewer'. All write routes (funding sources,
-- contacts, closed deals) require role in ('admin','editor'), so the entire
-- team was 403'd on every save. The email whitelist is the real security gate
-- (only @yourcompany.example + the listed emails can authenticate at all),
-- so authorized staff should be 'editor' by default.
--
-- Idempotent (re-running flips nothing once a user is editor) and scoped to
-- the whitelist in src/lib/auth/authorized.ts so we never elevate a row that
-- the app layer would block anyway.

update public.users
set role = 'editor'
where role = 'viewer'
  and (
    lower(email) like '%@yourcompany.example'
    or lower(email) in ('owner@yourcompany.example')
  );
