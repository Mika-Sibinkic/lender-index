import { createServerClient } from '@supabase/ssr'
import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'

export async function getSupabaseServer() {
  const { getToken } = await auth()
  const token = await getToken({ template: 'supabase' }).catch(() => null)
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll() {
          /* server components can't set cookies */
        },
      },
      global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    }
  )
}
