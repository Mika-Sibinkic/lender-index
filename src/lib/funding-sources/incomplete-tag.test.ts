/**
 * "Save incomplete" said it flagged the lender for later. It stored the gap
 * list — which shows as a badge on the card — and tagged nothing, so the tag
 * row, which is where the team filters and scans, could not answer "what still
 * needs finishing".
 *
 * Both directions are pinned here. A tag that is only ever ADDED becomes a lie
 * the moment somebody fills the missing fields in, which is the same
 * screen-disagrees-with-the-system class as a stale fit chip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ensureTag = vi.fn()
const applyTag = vi.fn()
const removeTag = vi.fn()

vi.mock('@/lib/tags/repo', () => ({
  ensureTag: (...a: unknown[]) => ensureTag(...a),
  applyTag: (...a: unknown[]) => applyTag(...a),
  removeTag: (...a: unknown[]) => removeTag(...a),
}))

const { syncIncompleteTag, INCOMPLETE_TAG } = await import('@/lib/funding-sources/incomplete-tag')

// The helper only ever hands this to the mocked repo functions.
const sb = {} as Parameters<typeof syncIncompleteTag>[0]

beforeEach(() => {
  ensureTag.mockReset().mockResolvedValue({ id: 'tag-1', name: INCOMPLETE_TAG })
  applyTag.mockReset().mockResolvedValue(undefined)
  removeTag.mockReset().mockResolvedValue(undefined)
})

describe('syncIncompleteTag', () => {
  it('tags a record that still has gaps', async () => {
    await syncIncompleteTag(sb, { fundingSourceId: 'fs-1', gaps: ['Email', 'Lending Status'], userId: 'u-1' })
    expect(applyTag).toHaveBeenCalledWith(sb, {
      fundingSourceId: 'fs-1',
      tagId: 'tag-1',
      userId: 'u-1',
    })
    expect(removeTag).not.toHaveBeenCalled()
  })

  it('removes the tag once the gaps are filled', async () => {
    await syncIncompleteTag(sb, { fundingSourceId: 'fs-1', gaps: [], userId: 'u-1' })
    expect(removeTag).toHaveBeenCalledWith(sb, { fundingSourceId: 'fs-1', tagId: 'tag-1' })
    expect(applyTag).not.toHaveBeenCalled()
  })

  it('treats a null gap list as complete', async () => {
    await syncIncompleteTag(sb, { fundingSourceId: 'fs-1', gaps: null, userId: null })
    expect(removeTag).toHaveBeenCalled()
    expect(applyTag).not.toHaveBeenCalled()
  })

  it('never throws — a tagging failure must not fail the operator’s save', async () => {
    ensureTag.mockRejectedValue(new Error('tag table unreachable'))
    await expect(
      syncIncompleteTag(sb, { fundingSourceId: 'fs-1', gaps: ['Email'], userId: 'u-1' }),
    ).resolves.toBeUndefined()
  })

  it('uses one stable tag name so the filter row does not fragment', () => {
    expect(INCOMPLETE_TAG).toBe('incomplete')
  })
})
