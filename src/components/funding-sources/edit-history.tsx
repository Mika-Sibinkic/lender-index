import { Card } from '@/components/ui/card'
import { formatDistanceToNow } from 'date-fns'

export type EditEntry = {
  id: string
  field_name: string
  old_value: string | null
  new_value: string | null
  edited_at: string
  user_email: string | null
}

export function EditHistory({ edits }: { edits: EditEntry[] }) {
  if (!edits.length) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        No edits recorded yet.
      </Card>
    )
  }
  return (
    <Card className="p-4">
      <ul className="space-y-2 text-sm">
        {edits.map((e) => (
          <li key={e.id} className="border-l-2 border-muted pl-3">
            <div className="text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(e.edited_at), { addSuffix: true })}
              {' · '}
              {e.user_email ?? 'unknown'}
            </div>
            <div>
              <span className="font-medium">{e.field_name}</span>:{' '}
              <span className="line-through text-muted-foreground">
                {e.old_value ?? '—'}
              </span>{' '}
              → {e.new_value ?? '—'}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
