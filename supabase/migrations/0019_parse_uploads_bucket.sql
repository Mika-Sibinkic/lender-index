-- 0019: private storage bucket for large parse / past-deal uploads.
--
-- Root cause (HTTP 413 on large uploads): Vercel Functions reject any
-- request whose body exceeds 4.5 MB with `FUNCTION_PAYLOAD_TOO_LARGE` — before
-- our handler runs, so the in-app 10 MB guard never fired. The limit is a hard
-- platform cap and is not configurable
-- (https://vercel.com/docs/functions/limitations#request-body-size).
--
-- Fix: files larger than the multipart threshold are uploaded straight from the
-- browser to Supabase Storage via a service-role-signed upload URL, then fetched
-- server-side by /api/parse/file and /api/closed-deals and deleted after parse.
--
-- The bucket is private. The signed upload token (minted only for whitelisted
-- users by /api/uploads/sign) is the sole write grant, and reads happen with the
-- service-role key, so no storage.objects RLS policy is required — default-deny
-- already blocks anon/authenticated direct access.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'parse-uploads',
  'parse-uploads',
  false,
  26214400, -- 25 MiB
  array[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
