'use client'

import { useEffect, useState } from 'react'

/**
 * Standing notice when the on-prem AI is not fully available.
 *
 * Until now the app only admitted a problem *after* you hit it: run a search and
 * get a degraded banner, or try a document import and get an error. So during
 * an outage a user's experience was to attempt a Past Deals import, watch it
 * fail, and have no idea whether it was them, the file, or the system.
 * That is the "silent failure" shape — the system knew, and said nothing until
 * someone wasted their time.
 *
 * This asks the health endpoint once on mount and states plainly what does and
 * does not work right now. Two rules it follows:
 *   - When everything is healthy it renders NOTHING. A banner that is always
 *     there is furniture, and furniture gets ignored — including on the day it
 *     matters.
 *   - It never blocks anything. Search genuinely still works (exact structured
 *     matching, no AI hop), so the wording says so rather than implying the app
 *     is down.
 *
 * Deliberately client-side and best-effort: if the probe itself fails we render
 * nothing rather than claiming an outage we cannot confirm.
 */

type AiStatus = 'up' | 'down' | 'degraded' | 'unconfigured'
type ModelRole = 'text' | 'vision' | 'embed'

interface Health {
  ai?: AiStatus
  missingModels?: ModelRole[]
}

interface Notice {
  headline: string
  detail: string
}

/** Pure so the wording is testable without a DOM. */
export function noticeFor(h: Health | null): Notice | null {
  if (!h) return null
  const missing = h.missingModels ?? []

  if (h.ai === 'down') {
    return {
      headline: 'The office AI server is offline.',
      detail:
        'Search still works. It falls back to exact matching on geography, asset type and deal size. Reading documents (Add and Past Deals import) is unavailable until the office computer is back on.',
    }
  }
  if (h.ai === 'degraded') {
    return {
      headline: 'AI ranking is degraded.',
      detail:
        'Search is running on exact structured matching, so some relevant lenders may be ranked lower than usual. Nothing shown is wrong, there may just be more of it.',
    }
  }
  // Healthy embed, but a model this deployment needs is not installed — the exact
  // state that broke document import for weeks while search looked fine.
  if (missing.includes('text')) {
    return {
      headline: 'Document reading is unavailable.',
      detail:
        'Search is working normally. The office AI server is missing the model needed to read documents, so Add and Past Deals import will not fill fields. It is a one-line fix on the office computer.',
    }
  }
  return null
}

export function AiStatusBanner() {
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((h: Health | null) => {
        if (!cancelled) setNotice(noticeFor(h))
      })
      .catch(() => {
        /* can't confirm an outage → say nothing */
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!notice) return null

  return (
    <div
      role="status"
      className="border-b border-amber-500/40 bg-amber-500/10 px-6 py-2 text-center text-[12px] leading-snug text-amber-800 dark:text-amber-300"
    >
      <span className="font-medium">{notice.headline}</span>{' '}
      <span className="opacity-90">{notice.detail}</span>
    </div>
  )
}
