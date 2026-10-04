/**
 * Cline desktop credentials reader.
 *
 * The Cline desktop app persists its WorkOS OAuth session at
 * `~/.cline/data/settings/providers.json` and keeps it refreshed while the
 * app runs (rotating the access token roughly daily). The adapter never
 * refreshes tokens itself — a self-managed refresh would rotate the refresh
 * token out from under the desktop app and break its session — it only reads
 * whatever the app last persisted.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClineCredentials {
  /** Verbatim persisted access token (`workos:...` JWT); sent as Bearer. */
  accessToken: string
  /** Cline account id (`usr-...`); sent as the `clineUserId` header. */
  accountId: string
  /** Epoch ms the access token expires at, when the file declares one. */
  expiresAt?: number
}

export class CredentialsError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/** Env override for the Cline home, mirroring the desktop app's layout. */
export function defaultCredentialsPath(): string {
  const clineHome = process.env.CLINE_HOME?.trim()
  const base = clineHome && clineHome.length > 0 ? clineHome : join(homedir(), '.cline')
  return join(base, 'data', 'settings', 'providers.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read and validate the Cline provider credentials. Throws CredentialsError
 * with a user-actionable message on any missing/malformed shape.
 */
export async function readClineCredentials(path: string = defaultCredentialsPath()): Promise<ClineCredentials> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'CLINE_NOT_INSTALLED' : 'CLINE_UNREADABLE'
    throw new CredentialsError(
      `cline2dsh: cannot read Cline credentials at ${path} (${(err as Error).message}). ` +
        'Open the Cline desktop app and log in once, then retry.',
      code,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CredentialsError(`cline2dsh: ${path} is not valid JSON (Cline may be mid-write); retry shortly.`, 'CLINE_MALFORMED')
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new CredentialsError(`cline2dsh: unexpected providers.json shape at ${path}.`, 'CLINE_MALFORMED')
  }
  const cline = (parsed.providers as Record<string, unknown>).cline
  const settings = isRecord(cline) ? (cline as { settings?: unknown }).settings : undefined
  const authBlock = isRecord(settings) ? (settings as { auth?: unknown }).auth : undefined
  if (!isRecord(cline) || !isRecord(authBlock)) {
    throw new CredentialsError(
      'cline2dsh: no Cline account session found in providers.json. ' +
        'Open the Cline desktop app, sign in (Cline provider), then retry.',
      'CLINE_NOT_LOGGED_IN',
    )
  }
  const accessToken = (authBlock as { accessToken?: unknown }).accessToken
  const accountId =
    (authBlock as { accountId?: unknown }).accountId ??
    (isRecord((authBlock as { metadata?: unknown }).metadata)
      ? ((authBlock as { metadata?: { userInfo?: { clineUserId?: unknown } } }).metadata?.userInfo?.clineUserId as unknown)
      : undefined)
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CredentialsError('cline2dsh: providers.json has no accessToken; log in from the Cline desktop app.', 'CLINE_NOT_LOGGED_IN')
  }
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new CredentialsError('cline2dsh: providers.json has no accountId/clineUserId; log in from the Cline desktop app.', 'CLINE_NOT_LOGGED_IN')
  }
  const expiresAtRaw = (authBlock as { expiresAt?: unknown }).expiresAt
  const expiresAt = typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? expiresAtRaw : undefined
  return { accessToken, accountId, expiresAt }
}

/** Headers the Cline desktop client itself sends (attribution is OpenRouter-style). */
export function clineRequestHeaders(creds: ClineCredentials): Record<string, string> {
  return {
    clineUserId: creds.accountId,
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
  }
}

/** mtime cache: avoid re-parsing the file on every request when unchanged. */
interface CacheEntry {
  mtimeMs: number
  creds: ClineCredentials
}
let cache: CacheEntry | undefined
let cachePath = ''

export async function readClineCredentialsCached(path: string = defaultCredentialsPath()): Promise<ClineCredentials> {
  if (cache && cachePath === path) {
    try {
      const { mtimeMs } = await stat(path)
      if (mtimeMs === cache.mtimeMs) return cache.creds
    } catch {
      // fall through to a full read, which raises the precise error
    }
  }
  const creds = await readClineCredentials(path)
  try {
    const { mtimeMs } = await stat(path)
    cache = { mtimeMs, creds }
    cachePath = path
  } catch {
    cache = undefined
  }
  return creds
}
