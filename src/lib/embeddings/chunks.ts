/**
 * Sliding-window text chunker + bulk indexer for funding_source_doc_chunks.
 *
 * Chunking strategy: character-based windows (cheap, deterministic, no
 * tokenizer dep). Default 800-char window with 100-char overlap. Splits
 * on paragraph then sentence boundaries when possible so chunks read as
 * coherent units rather than mid-sentence cuts.
 *
 * For typical term sheets (1–5 pages of text), this produces
 * 5–25 chunks — plenty for kNN recall without flooding the embedder.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { llm, LLM_MODELS } from '@/lib/llm/client'
import { EMBEDDING_DIMS } from '.'

export interface ChunkOpts {
  windowChars?: number
  overlapChars?: number
  maxChunks?: number
}

const DEFAULTS: Required<ChunkOpts> = {
  windowChars: 800,
  overlapChars: 100,
  maxChunks: 50,
}

/** Split text into overlapping chunks at paragraph + sentence boundaries. */
export function chunkText(text: string, opts: ChunkOpts = {}): string[] {
  const { windowChars, overlapChars, maxChunks } = { ...DEFAULTS, ...opts }
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length === 0) return []
  if (cleaned.length <= windowChars) return [cleaned]

  const chunks: string[] = []
  let cursor = 0
  while (cursor < cleaned.length && chunks.length < maxChunks) {
    const end = Math.min(cursor + windowChars, cleaned.length)
    let slice = cleaned.slice(cursor, end)

    // Prefer to end at the last sentence / paragraph boundary in the
    // window. Only cut if the boundary lies in the back half so we don't
    // shrink chunks too aggressively on punctuation-light text.
    if (end < cleaned.length) {
      const halfMark = Math.floor(slice.length / 2)
      const boundaryRe = /[.!?\n]\s/g
      let lastCut = -1
      let m: RegExpExecArray | null
      while ((m = boundaryRe.exec(slice))) {
        if (m.index >= halfMark) lastCut = m.index + 1
      }
      if (lastCut > 0) slice = slice.slice(0, lastCut)
    }

    const trimmed = slice.trim()
    if (trimmed.length > 0) chunks.push(trimmed)
    if (end >= cleaned.length) break
    cursor += Math.max(1, slice.length - overlapChars)
  }
  return chunks
}

export interface IndexDocResult {
  document_id: string | null
  chunks: number
  ok: number
  skipped: number
}

/**
 * Chunk + embed + upsert a document body for a funding source. Best-effort
 * per chunk — failures are logged and skipped (search degrades gracefully).
 *
 * If `documentId` is omitted, a row is inserted into funding_source_documents
 * first so chunks have a parent to FK against.
 */
export async function indexDocumentChunks(
  supabase: SupabaseClient,
  args: {
    fundingSourceId: string
    documentId?: string
    bodyText: string
    fileUrl?: string
    fileType?: string
    provider?: string
    chunkOpts?: ChunkOpts
  },
): Promise<IndexDocResult> {
  const text = args.bodyText?.trim() ?? ''
  if (text.length === 0) {
    return { document_id: args.documentId ?? null, chunks: 0, ok: 0, skipped: 0 }
  }

  let documentId = args.documentId
  if (!documentId) {
    const { data, error } = await supabase
      .from('funding_source_documents')
      .insert({
        funding_source_id: args.fundingSourceId,
        file_url: args.fileUrl ?? '(inline-paste)',
        file_type: args.fileType ?? 'text/plain',
        body_text: text,
        provider: args.provider ?? null,
      })
      .select('id')
      .single()
    if (error) {
      console.warn(`indexDocumentChunks: document insert failed: ${error.message}`)
      return { document_id: null, chunks: 0, ok: 0, skipped: 0 }
    }
    documentId = data.id
  } else {
    await supabase
      .from('funding_source_documents')
      .update({ body_text: text, provider: args.provider ?? null })
      .eq('id', documentId)
  }

  const pieces = chunkText(text, args.chunkOpts)
  let ok = 0
  let skipped = 0

  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]
    try {
      const { embeddings } = await llm.embed({
        supabase,
        module: 'embeddings.doc_chunk',
        values: [piece],
      })
      const vec = embeddings[0]
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
        console.warn(`indexDocumentChunks: dim mismatch ${vec?.length}`)
        skipped += 1
        continue
      }
      const { error: upErr } = await supabase
        .from('funding_source_doc_chunks')
        .upsert(
          {
            funding_source_id: args.fundingSourceId,
            document_id: documentId,
            chunk_index: i,
            text: piece,
            embedding: vec,
            model: LLM_MODELS.embed,
            dims: EMBEDDING_DIMS,
          },
          { onConflict: 'document_id,chunk_index' },
        )
      if (upErr) {
        console.warn(`indexDocumentChunks: upsert failed: ${upErr.message}`)
        skipped += 1
      } else {
        ok += 1
      }
    } catch (e) {
      console.warn(`indexDocumentChunks: embed failed: ${(e as Error).message}`)
      skipped += 1
    }
  }

  if (documentId) {
    await supabase
      .from('funding_source_documents')
      .update({ indexed_at: new Date().toISOString() })
      .eq('id', documentId)
  }

  return { document_id: documentId ?? null, chunks: pieces.length, ok, skipped }
}
