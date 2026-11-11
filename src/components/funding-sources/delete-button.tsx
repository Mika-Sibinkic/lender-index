'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

export function DeleteButton({
  id,
  companyName,
}: {
  id: string
  companyName: string
}) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/funding-sources/${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error('Delete failed', { description: err?.error ?? `HTTP ${res.status}` })
        return
      }
      toast.success(`Deleted ${companyName}`)
      router.push('/')
      router.refresh()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="sm"
            className="text-[12px] uppercase tracking-[0.16em] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            Delete source
          </Button>
        )}
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-heading">
            Delete {companyName}?
          </AlertDialogTitle>
          {/* This copy claimed "Edit history is preserved for audit" while the
              funding_source_edits FK was ON DELETE CASCADE — the delete wiped
              the whole history, including the row written to record the delete
              itself. 0021_audit_integrity.sql made the promise true, but only
              in the audit table: the rows detach from the record (their
              funding_source_id goes NULL) and there is no screen that lists
              them, so say that rather than imply the history stays browsable. */}
          <AlertDialogDescription>
            This permanently removes the funding source and its contacts. Its edit
            history is kept in the audit log under &ldquo;{companyName}&rdquo;, but
            will no longer be viewable in the app. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
