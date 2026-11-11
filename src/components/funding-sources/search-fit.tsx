'use client'

import { useSearchParams } from 'next/navigation'

import { useEffect, useState } from 'react'
import { Ban, Check, Minus, PauseCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Search-fit overlay: renders the geo/asset/size verdict chips + feeds the deal
 * amount to the appetite bar's marker — but ONLY for the exact search that
 * produced the current result set.
 *
 * The verdict comes straight from the server's FitVerdict (accuracy-guaranteed);
 * we never recompute fit on the client, which could silently diverge from the
 * matching logic. FilterBar stashes {idsKey, deal, fitById} in sessionStorage on
 * each search; we only apply it when the stash's idsKey matches the live `?ids=`,
 * so a stale search never paints fit onto a plain browse.
 */

type Dim = 'match' | 'unknown' | 'contradict'

export interface StashedFit {
  asset: Dim
  geo: Dim
  size: Dim
  intl: Dim
  usage: Dim
  operation: Dim
  lenderType: Dim
  /** Record states the lender is closed for business; it sorted to the bottom. */
  notLending?: boolean
  /**
   * The record NAMES the state or country that was searched for, rather than
   * covering it through a nationwide phrase — so it sorted above the nationwide
   * lenders. Optional because a stash written before 2026-09-09 will not have it.
   */
  localToRequest?: boolean
  /**
   * The lender's own `internal_notes` named, or ruled out, the place that was
   * searched for — or said lending has stopped. Each carries the sentence it was
   * read from, which is what the operator actually needs: a machine reading of
   * prose is only trustworthy if you can see the prose.
   *
   * Optional: a stash written before 2026-09-14 will not have them.
   */
  notesPrefer?: string | null
  notesAvoid?: string | null
  notesPaused?: string | null
}

interface Stash {
  idsKey: string
  deal: { min: number | null; max: number | null }
  fitById: Record<string, StashedFit>
}

export const SEARCH_FIT_KEY = 'lender-index:searchfit'

function readStash(): Stash | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(SEARCH_FIT_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Stash
    const liveIds = new URLSearchParams(window.location.search).get('ids')
    if (!liveIds || liveIds !== s.idsKey) return null
    return s
  } catch {
    return null
  }
}

export interface SearchFit {
  deal: { min: number | null; max: number | null }
  fit: StashedFit | null
}

/** Fit + deal for a row, or null when the current view isn't that search's results. */
export function useSearchFit(rowId: string): SearchFit | null {
  const [state, setState] = useState<SearchFit | null>(null)
  // Depend on the live `ids` param, not just the row id.
  //
  // readStash() already refuses to return anything when the URL's ids no longer
  // match the stash. The bug was that it never got asked again: the effect was
  // keyed on [rowId], and a client-side navigation from a search result list to
  // a plain browse keeps a row component MOUNTED whenever the same lender
  // appears in both. So the effect never re-ran and the row kept painting the
  // previous search's Geo/Asset/Size verdicts.
  //
  // Repro: after a search and then narrowing to Lender=Bank with no query at
  // all, a lender row still showed "—Geo ✓Asset —Size". A hard reload cleared it,
  // which is what identified the mounted-component cause.
  const ids = useSearchParams().get('ids') ?? ''
  // sessionStorage is client-only, so reading it during render would make the
  // server output (no chips) disagree with the first client render (chips) and
  // trip hydration. The effect is the correct place for after-hydration client
  // state; the one extra render per row is the cost of that, not a cascade.
  useEffect(() => {
    const s = readStash()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setState(s ? { deal: s.deal, fit: s.fitById[rowId] ?? null } : null)
  }, [rowId, ids])
  return state
}

const DIMS = [
  ['geo', 'Geo'],
  ['asset', 'Asset'],
  ['size', 'Size'],
] as const

function chipStyle(v: Dim) {
  if (v === 'match')
    return {
      Icon: Check,
      word: 'matches',
      cls: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
    }
  if (v === 'contradict')
    return {
      Icon: X,
      word: 'contradicts',
      cls: 'bg-rose-500/12 text-rose-700 ring-rose-500/25 dark:text-rose-300',
    }
  return {
    Icon: Minus,
    word: 'not stated',
    cls: 'bg-muted text-muted-foreground ring-border/60',
  }
}

/**
 * "This lender's record names the place you asked for."
 *
 * Extracted so the browse path can render it without a client stash. A common
 * workflow is Narrow by → State with no sentence, which is server
 * rendered; the rows were sorting correctly there and saying nothing about why.
 */
export function LocalChip() {
  return (
    <span
      title="This lender's record names the location you searched for, rather than covering it as part of a nationwide footprint. Sorted above nationwide lenders."
      className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/12 px-1.5 py-px text-[10px] font-medium text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:text-sky-300"
    >
      <Check size={10} strokeWidth={2.75} aria-hidden />
      Local
    </span>
  )
}

/**
 * The notes said something about this place, and here is the sentence.
 *
 * The quote is the whole point. A notes-derived signal is a model reading prose,
 * so it may be wrong — and the accuracy mandate's answer to "may be wrong" is
 * that it may rank but never exclude, and that a human can see it. Hovering a
 * chip shows the exact words, so a wrong read is one glance from being caught
 * and corrected on the record card.
 */
export function NotesLocalChip({ quote }: { quote: string }) {
  return (
    <span
      title={`The notes name this location: "${quote}"`}
      className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/10 px-1.5 py-px text-[10px] font-medium text-sky-700 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300"
    >
      <Check size={10} strokeWidth={2.75} aria-hidden />
      Local (notes)
    </span>
  )
}

export function NotesAvoidChip({ quote }: { quote: string }) {
  return (
    <span
      title={`The notes rule this location out: "${quote}" — ranked last, not removed. Open the record to confirm it.`}
      className="inline-flex items-center gap-0.5 rounded-full bg-rose-500/12 px-1.5 py-px text-[10px] font-medium text-rose-700 ring-1 ring-inset ring-rose-500/25 dark:text-rose-300"
    >
      <Ban size={10} strokeWidth={2.75} aria-hidden />
      Notes exclude this area
    </span>
  )
}

export function NotesPausedChip({ quote }: { quote: string }) {
  return (
    <span
      title={`The notes say lending may have stopped: "${quote}". Ranking is unchanged; open the record to settle it.`}
      className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-500/20 dark:text-amber-300"
    >
      <PauseCircle size={10} strokeWidth={2.75} aria-hidden />
      Check status
    </span>
  )
}

export function FitChips({
  rowId,
  className,
  /** Browse-path fallback: the server already scored this row. */
  localFallback = false,
  notLendingFallback = false,
  notesFallback,
}: {
  rowId: string
  className?: string
  localFallback?: boolean
  /** Browse-path fallback: this row already carries a DORMANT / not-lending badge. */
  notLendingFallback?: boolean
  /**
   * Browse-path fallback for the notes signals, same reason as localFallback:
   * facets-with-no-sentence render on the server and write no client stash, so
   * without this the rows reorder on the strength of a sentence the operator
   * never sees. That is the path operators actually use.
   */
  notesFallback?: { prefer?: string | null; avoid?: string | null; paused?: string | null }
}) {
  const sf = useSearchFit(rowId)
  // No search ran, but the server already scored this row. Render what it found,
  // so the ordering on the browse path is legible.
  if (!sf?.fit) {
    const nf = notesFallback
    // Same two suppressions as the search path below.
    const showNotesLocal = !!nf?.prefer && !localFallback
    const showPaused = !!nf?.paused && !notLendingFallback
    const anything = localFallback || showNotesLocal || nf?.avoid || showPaused
    if (!anything) return null
    return (
      <div className={cn('flex flex-wrap items-center gap-1', className)} aria-label="Deal fit">
        {localFallback && <LocalChip />}
        {showNotesLocal && <NotesLocalChip quote={nf!.prefer!} />}
        {nf?.avoid && <NotesAvoidChip quote={nf.avoid} />}
        {showPaused && <NotesPausedChip quote={nf!.paused!} />}
      </div>
    )
  }
  const fit = sf.fit
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} aria-label="Deal fit">
      {DIMS.map(([k, label]) => {
        const { Icon, word, cls } = chipStyle(fit[k])
        return (
          <span
            key={k}
            title={`${label}: ${word}`}
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium ring-1 ring-inset',
              cls
            )}
          >
            <Icon size={10} strokeWidth={2.75} aria-hidden />
            {label}
          </span>
        )
      })}
      {/*
        Why this lender is above the nationwide ones.
        Narrowing by State used to return every nationwide lender alongside
        the ones in that state. The local ones now sort first — but a
        reordering nobody can see reads as randomness. The chip says
        the record named this place rather than covering it nationwide.
      */}
      {fit.localToRequest && <LocalChip />}
      {/*
        Both of the next two are suppressed when the stronger, curated chip beside
        them already says it. Seen in production: one lender wore "Local" AND
        "Local (notes)", and dormant lenders wore "DORMANT" AND "Check status".
        Two chips making one point is cognitive load worth cutting, and a redundant caution is how a caution stops being read.
      */}
      {fit.notesPrefer && !fit.localToRequest && <NotesLocalChip quote={fit.notesPrefer} />}
      {fit.notesAvoid && <NotesAvoidChip quote={fit.notesAvoid} />}
      {fit.notesPaused && !fit.notLending && <NotesPausedChip quote={fit.notesPaused} />}
      {fit.notLending && (
        <span
          title="This lender's record says it is not currently lending, so it is ranked below every lender that is."
          className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/12 px-1.5 py-px text-[10px] font-medium text-amber-700 ring-1 ring-amber-500/25 ring-inset dark:text-amber-300"
        >
          <PauseCircle size={10} strokeWidth={2.75} aria-hidden />
          Not lending
        </span>
      )}
    </div>
  )
}
