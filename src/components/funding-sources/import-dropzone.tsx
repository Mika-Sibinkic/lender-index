'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface FileResult {
  file: string
  rowsInSheet: number
  rowsParsed: number
  rowsSkipped?: number
  unmappedColumns?: string[]
  mergedCompanies?: Array<{ company_name: string; sheetRows: number }>
  contactsKept?: number
  warnings?: string[]
  reconciles?: boolean
  upserted: number
  tagLinks: number
  reindexed: number
  error?: string
}

/**
 * Drag-drop roster spreadsheets of funding sources here. On drop,
 * uploads to /api/import/funding-sources which parses, upserts, and
 * re-indexes for AI search. Shows a per-file result summary.
 */
export function ImportDropzone() {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [results, setResults] = useState<FileResult[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => /\.xlsx?$/i.test(f.name))
    if (arr.length === 0) {
      toast.error('Drop .xlsx roster files (see the README import template)')
      return
    }
    setBusy(true)
    setResults(null)
    try {
      const fd = new FormData()
      for (const f of arr) fd.append('files', f)
      const res = await fetch('/api/import/funding-sources', { method: 'POST', body: fd })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        toast.error('Import failed', { description: j.error ?? `HTTP ${res.status}` })
        return
      }
      const json = await res.json()
      setResults(json.results)
      // 200 is per request, not per file. A file that failed to parse comes back
      // inside `results` carrying an `error`, so res.ok on its own announced
      // "Imported 0 funding sources" over a run where nothing landed at all.
      const all = (json.results ?? []) as FileResult[]
      const failed = all.filter((r) => r.error)
      const total = all.reduce((n, r) => n + r.upserted, 0)
      const reasons = failed.map((r) => `${r.file}: ${r.error}`).join(' · ')
      if (all.length > 0 && failed.length === 0) {
        toast.success(`Imported ${total} funding sources`, {
          description: 'Search is up to date.',
        })
      } else if (failed.length < all.length) {
        toast.warning(
          `Imported ${total} funding sources — ${failed.length} of ${all.length} files failed`,
          { description: reasons },
        )
      } else {
        toast.error('Import failed', { description: reasons || 'No files were processed.' })
      }
      startTransition(() => router.refresh())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
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
          if (e.dataTransfer.files?.length) await upload(e.dataTransfer.files)
        }}
        className={
          'rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors ' +
          (dragging ? 'border-foreground/60 bg-accent/[0.05]' : 'border-border/70 bg-card/40')
        }
      >
        <div className="text-[15px] font-medium text-foreground/90">
          Drop funding-source spreadsheets here
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          className="hidden"
          onChange={async (e) => {
            if (e.target.files?.length) await upload(e.target.files)
            e.target.value = ''
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? 'Importing + indexing…' : 'Or choose files'}
        </Button>
      </div>

      {results && (
        <div className="overflow-hidden rounded-md border border-border/70 bg-card/60">
          <div className="border-b border-border/60 bg-muted/40 px-5 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Import results
          </div>
          <ul className="divide-y divide-border/45">
            {results.map((r) => (
              <li key={r.file} className="px-5 py-3 text-[13px]">
                <div className="font-medium text-foreground/90">{r.file}</div>
                {r.error ? (
                  <div className="text-[12px] text-red-600">{r.error}</div>
                ) : (
                  <div className="text-[12px] text-muted-foreground">
                    {r.rowsInSheet} rows in sheet · {r.rowsParsed} parsed · {r.rowsSkipped ?? 0} skipped
                    {' · '}{r.upserted} upserted · {r.reindexed} re-indexed
                    {r.contactsKept ? ` · ${r.contactsKept} extra contacts kept` : ''}
                    {r.mergedCompanies?.length
                      ? ` · ${r.mergedCompanies.length} companies built from multiple rows`
                      : ''}
                    {r.reconciles === false && (
                      <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">
                        — rows unaccounted for
                      </span>
                    )}
                    {r.unmappedColumns?.length ? (
                      <span className="mt-1 block text-amber-700 dark:text-amber-400">
                        Columns not read by the importer: {r.unmappedColumns.join(' | ')}
                      </span>
                    ) : null}
                    {r.warnings?.map((w) => (
                      <span key={w} className="mt-1 block text-amber-700 dark:text-amber-400">
                        {w}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
