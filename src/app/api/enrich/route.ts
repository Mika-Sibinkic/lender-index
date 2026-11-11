import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    {
      error: 'not_implemented',
      detail: 'Not implemented: email-extraction-then-enrichment.',
    },
    { status: 501 }
  )
}
