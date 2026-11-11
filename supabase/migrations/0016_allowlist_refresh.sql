-- 0016: re-issue the RLS access allowlist with an explicit email list.
-- Allowlist is now: any @yourcompany.example + owner@yourcompany.example.
-- Idempotent (CREATE OR REPLACE). Superseded by 0025 (access_allowlist table).

CREATE OR REPLACE FUNCTION _is_authorized_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT (
    lower(auth.jwt() ->> 'email') LIKE '%@yourcompany.example'
    OR lower(auth.jwt() ->> 'email') IN ('owner@yourcompany.example')
  )
$$;
