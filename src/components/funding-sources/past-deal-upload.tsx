'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { uploadToStorage, LARGE_FILE_THRESHOLD } from '@/lib/upload/storage-upload'
import { humanError } from '@/lib/ui/error-message'

/**
 * Drop zone for term sheets / proposal letters / signed loan docs on
 * the Past Deals tab. Uploads to /api/closed-deals with the current
 * source id pre-bound, refreshes the panel on success.
 */
export function PastDealUpload({ fundingSourceId }: { fundingSourceId: string }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(file: File, sourceKind: string) {
    if (file.size > 25 * 1024 * 1024) {
      toast.error('File too large (25MB max)')
      return
    }
    setBusy(true)
    try {
      // Large PDFs bypass Vercel's 4.5 MB body limit via Supabase Storage;
      // small ones keep the direct multipart path.
      let res: Response
      try {
        if (file.size >= LARGE_FILE_THRESHOLD) {
          const ref = await uploadToStorage(file, 'deal')
          res = await fetch('/api/closed-deals', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...ref, source_kind: sourceKind, funding_source_id: fundingSourceId }),
          })
        } else {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('source_kind', sourceKind)
          fd.append('funding_source_id', fundingSourceId)
          res = await fetch('/api/closed-deals', { method: 'POST', body: fd })
        }
      } catch (e) {
        toast.error('Could not import deal', {
          description: e instanceof Error ? e.message : 'upload failed',
        })
        return
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        toast.error('Could not import deal', { description: humanError(res.status, j.error) })
        return
      }
      const created = await res.json()
      toast.success('Past deal imported', {
        description:
          [created.asset_year, created.asset_make, created.asset_model]
            .filter(Boolean)
            .join(' ') || 'fields extracted',
      })
      startTransition(() => router.refresh())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) await upload(f, guessSourceKind(f.name))
      }}
      className={
        'mb-4 rounded-md border-2 border-dashed px-5 py-6 text-center transition-colors ' +
        (dragging ? 'border-foreground/60 bg-accent/[0.05]' : 'border-border/70 bg-card/40')
      }
    >
      <div className="text-[13px] text-foreground/85">
        Drop a term sheet, proposal, signed loan doc, or leasing spreadsheet (PDF or Excel) here
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Fills year / make / model, loan, rate, LTV, prepayment.
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf,.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (f) await upload(f, guessSourceKind(f.name))
          e.target.value = ''
        }}
      />
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy ? 'Extracting…' : 'Or choose file'}
      </Button>
    </div>
  )
}

function guessSourceKind(name: string): 'term_sheet' | 'proposal' | 'loan_doc' {
  const lower = name.toLowerCase()
  if (lower.includes('proposal')) return 'proposal'
  if (lower.includes('loan') || lower.includes('signed') || lower.includes('execut'))
    return 'loan_doc'
  return 'term_sheet'
}
