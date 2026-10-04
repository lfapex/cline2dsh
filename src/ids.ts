import { createHash, randomUUID } from 'node:crypto'

/**
 * Stable per-conversation identifiers for Cline request headers.
 *
 * Cline's backend is OpenRouter-attributed; the desktop client derives stable
 * conversation/session ids so upstream prompt caching can key on them. We do
 * the same: the session id is a SHA-256 over (model, system, first user
 * message) — stable across retries of the same turn, different across turns —
 * and every request carries a fresh request id.
 */

export interface RequestIDs {
  session: string
  request: string
}

function hashParts(...parts: Array<string | undefined>): string {
  const h = createHash('sha256')
  for (const part of parts) {
    h.update(part ?? '\u0000')
    h.update('\u0001')
  }
  return h.digest('hex')
}

export function deriveRequestIDs(options: {
  model: string
  system?: string | undefined
  firstMessageText?: string | undefined
}): RequestIDs {
  const session = hashParts(options.model, options.system, options.firstMessageText).slice(0, 32)
  return { session, request: randomUUID() }
}
