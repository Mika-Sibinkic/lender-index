-- Typed signals read out of the free-text `internal_notes` column.
--
-- Roster notes carry real matching criteria that exist nowhere else on the
-- row: "Nebraska based" on a lender whose structured geography is a bare `US`,
-- "No HI or AK", "No Canada", "cannot consider india". In a real roster most
-- rows have notes, and many contain a negation, a US state code or a country.
--
-- Derived, never typed by a human. Populated by scripts/extract-note-signals.ts
-- and refreshed on write by the PATCH route whenever `internal_notes` changes,
-- the same way `required_field_gaps` (migration 0006) and the embedding are.
-- Re-derivable from scratch at any time; dropping the column loses nothing but
-- the ordering it produces.
--
-- Shape is documented by src/lib/notes/signals.ts (NoteSignals). Every entry
-- carries the verbatim sentence it came from, and an entry whose quote is not
-- literally present in the notes is discarded before it is ever written here.
--
-- These signals RANK and never EXCLUDE: they are an LLM's reading of prose, so
-- an inferred value may reorder results but must never hide a lender.

alter table public.funding_sources
  add column if not exists note_signals jsonb;

comment on column public.funding_sources.note_signals is
  'Machine-derived from internal_notes. Ranking signal only — never hard-excludes a lender. Each entry carries the verbatim quote it was read from. See src/lib/notes/signals.ts.';

-- Lets the batch script find rows whose notes changed since the last read
-- without scanning the jsonb.
create index if not exists fs_note_signals_version_idx
  on public.funding_sources ((note_signals ->> 'version'));
