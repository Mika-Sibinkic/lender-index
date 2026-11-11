import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Schema-contract tests: assertions the app code and the SQL migrations have to
 * agree on, checked against the migration files themselves because CI has no
 * database to point at.
 *
 * Both invariants here are real defects that shipped, not hypotheticals:
 *
 *  - parse_logs.input_modality's CHECK listed four values while
 *    /api/closed-deals wrote a fifth ('spreadsheet') from 2026-07-17 to
 *    2026-09-08. Every one of those inserts was rejected, and because the
 *    insert error was discarded the failure never surfaced — the modality with
 *    the least eval coverage was the one silently producing no training signal.
 *
 *  - funding_source_edits.funding_source_id was ON DELETE CASCADE, so deleting
 *    a funding source erased its entire audit trail, including the row written
 *    to record the deletion, while the delete dialog said the opposite.
 *
 * Both are invisible to typecheck and to every other test in the suite.
 * Fixed in supabase/migrations/0021_audit_integrity.sql.
 */

const REPO_ROOT = process.cwd()
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations')

/** Migrations in the order Postgres applies them. */
function migrationsInOrder(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: stripLineComments(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')),
    }))
}

/** `--` comments describe the old broken state; only executable SQL counts. */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('parse_logs.input_modality', () => {
  /** The last CHECK definition wins — that is the constraint that is live. */
  function allowedModalities(): { source: string; values: Set<string> } {
    let found: { source: string; values: Set<string> } | null = null
    for (const { name, sql } of migrationsInOrder()) {
      const matches = [
        ...sql.matchAll(/check\s*\(\s*input_modality\s+in\s*\(([^)]*)\)/gi),
      ]
      if (!matches.length) continue
      const literals = [...matches[matches.length - 1][1].matchAll(/'([^']+)'/g)].map(
        (m) => m[1],
      )
      found = { source: name, values: new Set(literals) }
    }
    if (!found) throw new Error('no input_modality CHECK found in supabase/migrations')
    return found
  }

  /**
   * Every modality literal the three parse-log writers can put on the wire.
   * Scanned from source rather than restated, so a route that invents a new
   * modality fails this test instead of failing silently in production.
   */
  function modalitiesWrittenByApp(): Set<string> {
    const writers = [
      'src/app/api/parse/route.ts',
      'src/app/api/parse/file/route.ts',
      'src/app/api/closed-deals/route.ts',
    ]
    const found = new Set<string>()
    for (const rel of writers) {
      const src = stripTsComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
      for (const line of src.split('\n')) {
        if (!/\bmodality\b/.test(line)) continue
        for (const m of line.matchAll(/'([a-z]+)'/g)) found.add(m[1])
      }
    }
    return found
  }

  it('scans a plausible modality set from the route sources', () => {
    // Guard against the scan above silently matching nothing and every
    // assertion below passing vacuously.
    const app = modalitiesWrittenByApp()
    expect(app.size).toBeGreaterThanOrEqual(4)
    expect(app).toContain('spreadsheet')
  })

  it('permits every modality the app writes', () => {
    const { source, values } = allowedModalities()
    const rejected = [...modalitiesWrittenByApp()].filter((m) => !values.has(m))
    expect(
      rejected,
      `${source} rejects modalities the app writes; extend the CHECK in the same commit`,
    ).toEqual([])
  })

  it("permits 'spreadsheet' — the value rejected from 2026-07-17 to 2026-09-08", () => {
    expect(allowedModalities().values).toContain('spreadsheet')
  })
})

describe('funding_source_edits audit trail', () => {
  /**
   * The effective ON DELETE action for funding_source_edits.funding_source_id:
   * an ALTER TABLE ... ADD CONSTRAINT wins over the inline column definition in
   * 0001, and the last migration to define one wins overall.
   */
  function effectiveOnDelete(): { source: string; action: string } {
    let found: { source: string; action: string } | null = null
    for (const { name, sql } of migrationsInOrder()) {
      const added = [
        ...sql.matchAll(
          /alter\s+table\s+public\.funding_source_edits[\s\S]*?foreign\s+key\s*\(\s*funding_source_id\s*\)[\s\S]*?on\s+delete\s+(cascade|set\s+null|restrict|no\s+action)/gi,
        ),
      ]
      if (added.length) {
        found = { source: name, action: normalize(added[added.length - 1][1]) }
        continue
      }
      const table = sql.match(
        /create\s+table\s+public\.funding_source_edits\s*\(([\s\S]*?)\n\s*\);/i,
      )
      const inline = table?.[1].match(
        /funding_source_id[^,\n]*references[^,\n]*on\s+delete\s+(cascade|set\s+null|restrict|no\s+action)/i,
      )
      if (inline) found = { source: name, action: normalize(inline[1]) }
    }
    if (!found) throw new Error('no funding_source_id FK found on funding_source_edits')
    return found
  }

  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')

  it('detaches history from a deleted funding source instead of erasing it', () => {
    const { source, action } = effectiveOnDelete()
    expect(
      action,
      `${source} leaves funding_source_edits ON DELETE ${action}; a cascade deletes the audit trail the delete dialog promises to keep`,
    ).toBe('set null')
  })

  it('keeps a detached history row identifiable', () => {
    // With funding_source_id NULLed out, company_name_at_delete is the only
    // column left saying which lender the history belonged to.
    const declared = migrationsInOrder().some((m) =>
      /alter\s+table\s+public\.funding_source_edits\s+add\s+column\s+if\s+not\s+exists\s+company_name_at_delete/i.test(
        m.sql,
      ),
    )
    expect(declared).toBe(true)

    const deleteRoute = readFileSync(
      path.join(REPO_ROOT, 'src/app/api/funding-sources/[id]/route.ts'),
      'utf8',
    )
    expect(stripTsComments(deleteRoute)).toContain('company_name_at_delete')
  })
})
