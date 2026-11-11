'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { QuickAddForm } from '@/components/funding-sources/quick-add-form'

/**
 * Pop-up create dialog — matches the UX agreed in the MVP-review call
 * (S20, S44, S57: "pop-up card, populate and tab over"). Wraps the
 * existing QuickAddForm so /new page and dialog share one implementation.
 */
export function CreateDialog({
  isAdmin = false,
  trigger,
}: {
  isAdmin?: boolean
  trigger: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto p-0 sm:max-w-3xl sm:p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>New funding source</DialogTitle>
        </DialogHeader>
        <QuickAddForm
          isAdmin={isAdmin}
          onCancel={() => setOpen(false)}
          onCreated={(id) => {
            setOpen(false)
            router.push(`/source/${id}`)
            router.refresh()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
