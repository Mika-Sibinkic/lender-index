import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const args = process.argv.slice(2)
// First non-flag arg, so `--yes` can sit on either side of the email.
const email = args.find((a) => !a.startsWith('--'))
const confirmed = args.includes('--yes')

if (!url || !serviceKey) {
  console.error('Missing SUPABASE env vars. Source .env.local first.')
  process.exit(1)
}
if (!email) {
  console.error('Usage: pnpm tsx scripts/promote-admin.ts <email> --yes')
  process.exit(1)
}

// Your production project ref (env) — named so the operator can see what they are aiming at.
const PRODUCTION_SUPABASE_REF = process.env.PRODUCTION_SUPABASE_REF?.trim()
const targetLabel =
  PRODUCTION_SUPABASE_REF && url.includes(PRODUCTION_SUPABASE_REF) ? `PRODUCTION (${url})` : url

// Granting admin is a privilege escalation on real data: admin bypasses the RLS
// role checks and can edit or delete any lender record. It ran on the bare
// command with no confirmation of any kind, and the whitelist is enforced in two
// places (authorized.ts + the RLS access_allowlist, 0025), so a mistyped address here is a real hole
// rather than a no-op. Explicit --yes, checked before any client call, so a
// half-remembered command can't escalate anyone.
if (!confirmed) {
  console.error(`REFUSING TO WRITE — this promotes a user to admin on ${targetLabel}.`)
  console.error(`  would set role='admin' for: ${email}`)
  console.error('  admin can edit or delete any lender record and bypasses the RLS role checks.')
  console.error('  Re-run with --yes if that is what you want:')
  console.error(`    pnpm tsx scripts/promote-admin.ts ${email} --yes`)
  process.exit(1)
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data, error } = await supabase
    .from('users')
    .update({ role: 'admin' })
    .eq('email', email)
    .select()
  if (error) {
    console.error('Failed:', error)
    process.exit(1)
  }
  if (!data?.length) {
    console.error(`No user found with email ${email}. Sign in once first.`)
    process.exit(1)
  }
  console.log(`Promoted ${email} to admin.`)
}

main()
