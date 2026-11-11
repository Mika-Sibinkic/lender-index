'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type Role = 'admin' | 'editor' | 'viewer'

export interface AdminUser {
  id: string
  email: string
  role: Role
  last_seen_at: string | null
}

const ROLE_OPTS: readonly { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
]

function fmtSeen(ts: string | null): string {
  if (!ts) return 'never'
  return new Date(ts).toLocaleString()
}

export function UsersTable({
  users: initial,
  currentUserId,
}: {
  users: AdminUser[]
  currentUserId: string
}) {
  const [users, setUsers] = React.useState<AdminUser[]>(initial)
  const [savingId, setSavingId] = React.useState<string | null>(null)

  async function changeRole(userId: string, role: Role) {
    const prev = users
    // Optimistic update; revert on failure.
    setUsers((rows) => rows.map((u) => (u.id === userId ? { ...u, role } : u)))
    setSavingId(userId)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: userId, role }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null
        const msg =
          typeof data?.error === 'string' ? data.error : 'Failed to update role.'
        setUsers(prev)
        toast.error(msg)
        return
      }
      const saved = (await res.json()) as AdminUser
      setUsers((rows) => rows.map((u) => (u.id === saved.id ? saved : u)))
      toast.success(`${saved.email} is now ${saved.role}.`)
    } catch {
      setUsers(prev)
      toast.error('Failed to update role.')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => {
          const isSelf = u.id === currentUserId
          return (
            <TableRow key={u.id}>
              <TableCell className="font-medium">
                {u.email}
                {isSelf && (
                  <span className="ml-2 text-[11px] text-muted-foreground">(you)</span>
                )}
              </TableCell>
              <TableCell>
                <Select
                  items={ROLE_OPTS as { value: Role; label: string }[]}
                  value={u.role}
                  onValueChange={(v) => {
                    const role = (v ?? '') as Role
                    if (!role || role === u.role) return
                    void changeRole(u.id, role)
                  }}
                  disabled={savingId === u.id}
                >
                  <SelectTrigger className="w-32" size="sm">
                    <SelectValue placeholder="Role" />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-[12px] text-muted-foreground tabular-nums">
                {fmtSeen(u.last_seen_at)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
