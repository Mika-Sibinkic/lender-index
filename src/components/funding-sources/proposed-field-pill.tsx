'use client'

import { useState } from 'react'
import { toast } from 'sonner'

export interface ProposedFieldInDialog {
  name: string
  data_type: string
  example_value: string
  /** id is only present if the parse pipeline persisted it (logged in). */
  id?: string
}

/**
 * Inline pill rendered inside the create dialog when the AI sees a key
 * we don't know about. Two paths:
 *
 *  - Editor (not admin): "Got it" — dismisses locally; the proposal row
 *    stays pending for an admin to triage in /api/proposed-fields.
 *  - Admin: "Add field" — calls POST /api/proposed-fields/[id] which
 *    runs the apply_proposed_field RPC and adds the column.
 *
 * If the pill has no id (e.g. dev mode without persistence), only the
 * dismiss path is available.
 */
export function ProposedFieldPill({
  proposal,
  isAdmin,
  onResolved,
}: {
  proposal: ProposedFieldInDialog
  isAdmin: boolean
  onResolved: (name: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function approve() {
    if (!proposal.id) {
      onResolved(proposal.name)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/proposed-fields/${proposal.id}`, { method: 'POST' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        toast.error('Could not add field', { description: j.error ?? `HTTP ${res.status}` })
      } else {
        toast.success(`Added column \`${proposal.name}\``, {
          description: 'Future imports will accept this field.',
        })
        onResolved(proposal.name)
      }
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!proposal.id) {
      onResolved(proposal.name)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/proposed-fields/${proposal.id}`, { method: 'DELETE' })
      if (res.ok) onResolved(proposal.name)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[12px]">
      <div className="min-w-0 flex-1">
        <div className="text-foreground/90">
          Saw <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{proposal.name}</code>
          {' '}= <span className="text-muted-foreground">&quot;{proposal.example_value}&quot;</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground/80">
          New field, {proposal.data_type}. {isAdmin ? 'Approve to add to the schema.' : 'An admin will review.'}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {isAdmin && proposal.id && (
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            className="rounded border border-amber-500/40 bg-amber-500/[0.08] px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-500/[0.16] disabled:opacity-50"
          >
            Add field
          </button>
        )}
        <button
          type="button"
          onClick={reject}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
