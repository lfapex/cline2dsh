import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { clineRequestHeaders, readClineCredentialsCached } from './credentials.ts'

/**
 * Free-model catalog for the Cline lane.
 *
 * Three tiers, mirroring opencode2dsh's fallback chain:
 *   1. live `GET {baseURL}/models` filtered to the free lane (`:free` ids),
 *      enriched with OpenRouter's public metadata (context window, image
 *      input) — OpenRouter is unreachable from some networks, so this
 *      enrichment is best-effort and never blocks the model list;
 *   2. a disk cache valid for 7 days (offline / upstream outage);
 *   3. a compiled-in static roster (verified 2026-10-04).
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export interface CatalogEntry {
  id: string
  contextWindow?: number
  maxOutput?: number
  input?: string[]
}

export interface CatalogSnapshot {
  status: 'live' | 'cache' | 'static' | 'pending'
  total: number
  exposed: number
  fetchedAt?: string
}

interface CacheFile {
  fetchedAt: string
  entries: CatalogEntry[]
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Verified free roster (GET /models `:free` intersection, 2026-10-04). */
export const STATIC_FREE_MODELS: string[] = [
  'apodex/apodex-1.1-mini:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'qwen/qwen3.8-27b:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  'poolside/laguna-s-2.1:free',
  'thinkingmachines/inkling:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
]

export function isFreeModel(id: string): boolean {
  return id.endsWith(':free')
}

export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'cache', 'catalog.json')
}

export function defaultDataDir(): string {
  return join(homedir(), '.cline2dsh')
}

export class ModelCatalog {
  readonly #baseURL: string
  readonly #credentialsPath: string
  readonly #cachePath: string
  readonly #refreshSeconds: number
  readonly #freeOnly: boolean
  readonly #fetchImpl: typeof fetch
  readonly #onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void

  #entries: Map<string, CatalogEntry> = new Map()
  #status: CatalogSnapshot['status'] = 'pending'
  #fetchedAt?: string
  #timer: NodeJS.Timeout | undefined
  #refreshing: Promise<void> | undefined

  constructor(options: {
    baseURL: string
    credentialsPath: string
    cachePath: string
    refreshSeconds: number
    freeOnly: boolean
    fetchImpl?: typeof fetch
    onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void
  }) {
    this.#baseURL = options.baseURL.replace(/\/+$/, '')
    this.#credentialsPath = options.credentialsPath
    this.#cachePath = options.cachePath
    this.#refreshSeconds = options.refreshSeconds
    this.#freeOnly = options.freeOnly
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#onRefresh = options.onRefresh
  }

  list(): string[] {
    if (this.#entries.size > 0) return [...this.#entries.keys()]
    return this.#freeOnly ? [...STATIC_FREE_MODELS] : [...STATIC_FREE_MODELS]
  }

  snapshot(): CatalogSnapshot {
    return {
      status: this.#status,
      total: this.#entries.size,
      exposed: this.#entries.size,
      ...(this.#fetchedAt ? { fetchedAt: this.#fetchedAt } : {}),
    }
  }

  limits(model: string): { contextWindow?: number; maxOutput?: number } | undefined {
    const entry = this.#entries.get(model)
    if (!entry) return undefined
    return { contextWindow: entry.contextWindow, maxOutput: entry.maxOutput }
  }

  modalities(model: string): string[] | undefined {
    const entry = this.#entries.get(model)
    return entry?.input
  }

  /** Initial cache read (tier 2); never throws. Returns a startup note or ''. */
  async prime(): Promise<string> {
    try {
      const raw = await readFile(this.#cachePath, 'utf8')
      const parsed = JSON.parse(raw) as CacheFile
      const age = Date.now() - new Date(parsed.fetchedAt).getTime()
      if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS && Array.isArray(parsed.entries)) {
        this.#ingest(parsed.entries, 'cache', parsed.fetchedAt)
        return `cache (${parsed.entries.length} models, age ${Math.round(age / 60_000)}m)`
      }
      return 'cache expired'
    } catch {
      return 'no cache'
    }
  }

  async start(): Promise<void> {
    await this.prime()
    await this.refresh()
    this.#timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = this.#refreshOnce().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  async #refreshOnce(): Promise<void> {
    try {
      const entries = await this.#fetchLive()
      if (entries.length > 0) {
        this.#ingest(entries, 'live', new Date().toISOString())
        await this.#writeCache(entries).catch(() => {})
        this.#announce('')
        return
      }
      throw new Error('model list came back empty')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.#entries.size === 0) {
        // tier 3: compiled-in roster so the picker is never empty
        this.#ingest(STATIC_FREE_MODELS.map((id) => ({ id })), 'static')
      }
      this.#announce(message)
    }
  }

  async #fetchLive(): Promise<CatalogEntry[]> {
    const creds = await readClineCredentialsCached(this.#credentialsPath || undefined)
    const url = `${this.#baseURL}/models`
    const response = await this.#fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        ...clineRequestHeaders(creds),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`GET ${url} -> ${response.status}`)
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> }
    const rows = body.data ?? body.models ?? []
    const ids: string[] = []
    for (const row of rows) {
      if (typeof row?.id !== 'string' || row.id.length === 0) continue
      if (this.#freeOnly && !isFreeModel(row.id)) continue
      ids.push(row.id)
    }
    if (ids.length === 0) return []
    const enriched = await this.#enrich(ids).catch(() => undefined)
    return ids.map((id) => enriched?.get(id) ?? { id })
  }

  /**
   * Best-effort OpenRouter metadata: context_length, max output, and image
   * input. Cline ids are OpenRouter ids verbatim, so the join is exact; any
   * failure (offline, blocked, shape change) only costs the enrichment.
   */
  async #enrich(ids: string[]): Promise<Map<string, CatalogEntry>> {
    const wanted = new Set(ids)
    const response = await this.#fetchImpl(OPENROUTER_MODELS_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`openrouter metadata -> ${response.status}`)
    const body = (await response.json()) as {
      data?: Array<{
        id?: string
        context_length?: number
        top_provider?: { max_completion_tokens?: number | null }
        architecture?: { input_modalities?: string[] }
      }>
    }
    const map = new Map<string, CatalogEntry>()
    for (const row of body.data ?? []) {
      if (typeof row?.id !== 'string' || !wanted.has(row.id)) continue
      const entry: CatalogEntry = { id: row.id }
      if (typeof row.context_length === 'number' && row.context_length > 0) entry.contextWindow = row.context_length
      if (typeof row.top_provider?.max_completion_tokens === 'number' && row.top_provider.max_completion_tokens > 0) {
        entry.maxOutput = row.top_provider.max_completion_tokens
      }
      const inputs = row.architecture?.input_modalities
      if (Array.isArray(inputs) && inputs.length > 0) {
        entry.input = inputs.includes('image') ? ['text', 'image'] : ['text']
      }
      map.set(row.id, entry)
    }
    return map
  }

  #ingest(entries: CatalogEntry[], status: CatalogSnapshot['status'], fetchedAt?: string): void {
    const next = new Map<string, CatalogEntry>()
    for (const entry of entries) {
      if (typeof entry?.id === 'string' && entry.id.length > 0) next.set(entry.id, entry)
    }
    if (next.size === 0) return
    this.#entries = next
    this.#status = status
    this.#fetchedAt = fetchedAt ?? new Date().toISOString()
  }

  async #writeCache(entries: CatalogEntry[]): Promise<void> {
    const file: CacheFile = { fetchedAt: new Date().toISOString(), entries }
    await mkdir(dirname(this.#cachePath), { recursive: true })
    await writeFile(this.#cachePath, JSON.stringify(file), 'utf8')
  }

  #announce(lastError: string): void {
    this.#onRefresh?.(this.snapshot(), lastError)
  }
}
