-- 0020: private storage bucket for nightly logical backups.
--
-- Why this exists: the Supabase free tier does not provide point-in-time
-- recovery, and a backup job that depends on a separate always-on machine
-- silently stops when that machine sleeps or is unreachable. This runs the dump
-- on the same daily Vercel cron infrastructure that already runs outreach and
-- warmup. See /api/cron/backup.
--
-- Honest limit, recorded here so nobody over-trusts it: a backup living in the
-- same Supabase project it backs up protects against the realistic failures —
-- an accidental bulk delete, a bad spreadsheet import, a botched migration,
-- someone clearing a column — but NOT against losing the Supabase account
-- itself. Off-site copies are a separate concern.
--
-- Private bucket. Written and read only with the service-role key from the cron
-- route, so default-deny on storage.objects is the whole access story and no
-- RLS policy is required (same reasoning as 0019).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'backups',
  'backups',
  false,
  26214400, -- 25 MiB. Matches 0019 and the project's global upload cap; the whole
            -- public schema as gzipped JSON is well under 1 MiB today.
  array['application/gzip', 'application/json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
