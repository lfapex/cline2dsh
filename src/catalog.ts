import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { clineRequestHeaders, getValidAccessToken } from './credentials.ts'

/**
 * Free-model catalog for the Cline lane.
 *
 * Cline's "free" is TWO disjoint families (verified 2026-10-04):
 *   1. Cline's own promo free fleet, served by
 *      `GET {baseURL}/ai/cline/recommended-models` in the `free` bucket —
 *      ids carry the `cline-free/` routing prefix (plus OpenRouter-style
 *      sponsored ids like `stealth/space-bunny-alpha`). Requests route on
 *      that prefix and the backend gates them on client identity headers,
 *      not on the token alone. The `clinePass` bucket of the same endpoint
 *      requires a Cline Pass subscription (403 ENTITLEMENT_ERROR without
 *      one), so it is opt-in (`includeClinePass`).
 *   2. OpenRouter-routed free models: `/models` rows whose id carries the
 *      `:free` suffix.
 *
 * Fallback chain: live (recommended-models ∪ :free rows, OpenRouter metadata
 * enrichment best-effort) → 7-day disk cache → compiled-in static roster.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export interface CatalogEntry {
  id: string
  /** Human display name from the Cline free bucket when available. */
  name?: string
  /** Which free family an entry came from; 'cline' sorts first. */
  source?: 'cline' | 'openrouter'
  contextWindow?: number
  maxOutput?: number
  input?: string[]
}

export interface CatalogSnapshot {
  status: 'live' | 'cache' | 'static' | 'pending'
  total: number
  exposed: number
  freeBucket: number
  clinePass: number
  openrouterFree: number
  fetchedAt?: string
}

interface CacheFile {
  fetchedAt: string
  entries: CatalogEntry[]
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Display-name badge pinned to the Cline free fleet. Some picker surfaces
 * re-sort options alphabetically and ignore adapter order; `!` sorts before
 * every letter under both code-point and locale collation (tested), so the
 * badge pins the fleet to the top in either world. Display-only — the wire
 * model id is untouched.
 */
export const FLEET_BADGE = '! '

export function fleetDisplayName(raw: string | undefined, id: string): string {
  return FLEET_BADGE + prettifyBucketName(raw, id)
}

/** Verified free roster (free bucket ∪ /models `:free`, 2026-10-04). */
export const STATIC_FREE_MODELS: CatalogEntry[] = [
  { id: 'cline-free/deepseek-v4.1-flash', name: FLEET_BADGE + 'Deepseek-v4.1-Flash', source: 'cline' },
  { id: 'stealth/space-bunny-alpha', name: FLEET_BADGE + 'Space Bunny Alpha', source: 'cline' },
  { id: 'cline-free/mimo-v2.6-flash', name: FLEET_BADGE + 'Mimo V2.6 Flash', source: 'cline' },
  { id: 'cline-free/muse-spark-1.3-contributor', name: FLEET_BADGE + 'Muse Spark 1.3 Contributor', source: 'cline' },
  { id: 'apodex/apodex-1.1-mini:free', source: 'openrouter' },
  { id: 'inclusionai/ling-3.0-flash-sante:free', source: 'openrouter' },
  { id: 'qwen/qwen3.8-27b:free', source: 'openrouter' },
  { id: 'dots-studio/dots-3-note-preview:free', source: 'openrouter' },
  { id: 'liquid/lfm-2.5-2.6b:free', source: 'openrouter' },
  { id: 'nvidia/nemotron-3.5-lightning:free', source: 'openrouter' },
  { id: 'thinkingmachines/inkling-small:free', source: 'openrouter' },
  { id: 'poolside/laguna-s-2.1:free', source: 'openrouter' },
  { id: 'thinkingmachines/inkling:free', source: 'openrouter' },
  { id: 'poolside/laguna-xs-2.1:free', source: 'openrouter' },
  { id: 'cohere/north-mini-code:free', source: 'openrouter' },
  { id: 'nvidia/nemotron-3.5-content-safety:free', source: 'openrouter' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', source: 'openrouter' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', source: 'openrouter' },
  { id: 'google/gemma-4-26b-a4b-it:free', source: 'openrouter' },
  { id: 'google/gemma-4-31b-it:free', source: 'openrouter' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', source: 'openrouter' },
]

export function isFreeModel(id: string): boolean {
  return id.endsWith(':free')
}

/** "cline-pass/glm-5.3" -> "Glm 5.3"; bucket names are often raw ids. */
export function prettifyBucketName(raw: string | undefined, id: string): string {
  if (typeof raw === 'string' && raw.length > 0 && !raw.includes('/') && !/^[a-z0-9.-]+$/.test(raw)) return raw
  const short = (raw ?? id).split('/').at(-1) ?? id
  return short
    .replace(/[:].*$/, '')
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'cache', 'catalog.json')
}

export function defaultDataDir(): string {
  return join(homedir(), '.cline2dsh')
}

interface BucketRow {
  id?: string
  name?: string
  description?: string
}

export class ModelCatalog {
  readonly #baseURL: string
  readonly #credentialsPath: string
  readonly #cachePath: string
  readonly #refreshSeconds: number
  readonly #freeOnly: boolean
  readonly #includeClinePass: boolean
  readonly #fetchImpl: typeof fetch
  readonly #onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void

  #entries: Map<string, CatalogEntry> = new Map()
  #ordered: string[] = []
  #status: CatalogSnapshot['status'] = 'pending'
  #fetchedAt?: string
  #counts = { freeBucket: 0, clinePass: 0, openrouterFree: 0 }
  #timer: NodeJS.Timeout | undefined
  #refreshing: Promise<void> | undefined

  constructor(options: {
    baseURL: string
    credentialsPath: string
    cachePath: string
    refreshSeconds: number
    freeOnly: boolean
    includeClinePass?: boolean
    fetchImpl?: typeof fetch
    onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void
  }) {
    this.#baseURL = options.baseURL.replace(/\/+$/, '')
    this.#credentialsPath = options.credentialsPath
    this.#cachePath = options.cachePath
    this.#refreshSeconds = options.refreshSeconds
    this.#freeOnly = options.freeOnly
    this.#includeClinePass = options.includeClinePass === true
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#onRefresh = options.onRefresh
  }

  list(): string[] {
    if (this.#entries.size > 0) return [...this.#ordered]
    return STATIC_FREE_MODELS.map((entry) => entry.id)
  }

  /** Picker order: Cline's own free fleet first, then by display name. */
  #compare(a: CatalogEntry, b: CatalogEntry): number {
    const rank = (entry: CatalogEntry) => (entry.source === 'cline' ? 0 : 1)
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const an = (this.display(a.id) ?? a.id).toLowerCase()
    const bn = (this.display(b.id) ?? b.id).toLowerCase()
    if (an !== bn) return an < bn ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }

  display(model: string): string {
    return this.#entries.get(model)?.name ?? model
  }

  snapshot(): CatalogSnapshot {
    return {
      status: this.#status,
      total: this.#entries.size,
      exposed: this.#entries.size,
      ...this.#counts,
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
      const [buckets, orFree] = await Promise.all([this.#fetchFreeBuckets(), this.#fetchOpenRouterFree()])
      const entries = new Map<string, CatalogEntry>()
      for (const entry of buckets.entries()) entries.set(entry[0], entry[1])
      for (const entry of orFree) {
        if (!entries.has(entry.id)) entries.set(entry.id, entry)
      }
      if (entries.size === 0) throw new Error('both free sources came back empty')
      this.#ingest([...entries.values()], 'live', new Date().toISOString())
      await this.#writeCache([...entries.values()]).catch(() => {})
      this.#announce('')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.#entries.size === 0) {
        this.#ingest(STATIC_FREE_MODELS, 'static')
      }
      this.#announce(message)
    }
  }

  /** Cline's own free fleet (the `free` bucket; `clinePass` is opt-in). */
  async #fetchFreeBuckets(): Promise<Map<string, CatalogEntry>> {
    const { accessToken, accountId } = await getValidAccessToken({ baseURL: this.#baseURL, credentialsPath: this.#credentialsPath })
    const url = `${this.#baseURL}/ai/cline/recommended-models`
    const response = await this.#fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...clineRequestHeaders(accountId),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)
    const body = (await response.json()) as { free?: BucketRow[]; clinePass?: BucketRow[] }
    const entries = new Map<string, CatalogEntry>()
    const take = (rows: BucketRow[] | undefined, tag: 'free' | 'clinePass'): number => {
      let n = 0
      for (const row of rows ?? []) {
        if (typeof row?.id !== 'string' || row.id.length === 0) continue
        n += 1
        if (tag === 'clinePass' && !this.#includeClinePass) continue
        if (entries.has(row.id)) continue
        entries.set(row.id, { id: row.id, name: fleetDisplayName(row.name, row.id), source: 'cline' })
      }
      return n
    }
    this.#counts.freeBucket = take(body.free, 'free')
    this.#counts.clinePass = take(body.clinePass, 'clinePass')
    return entries
  }

  /** OpenRouter-routed free models: `:free` suffix rows of GET /models. */
  async #fetchOpenRouterFree(): Promise<CatalogEntry[]> {
    const { accessToken, accountId } = await getValidAccessToken({ baseURL: this.#baseURL, credentialsPath: this.#credentialsPath })
    const url = `${this.#baseURL}/models`
    const response = await this.#fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...clineRequestHeaders(accountId),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)
    const body = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> }
    const rows = body.data ?? body.models ?? []
    const ids: string[] = []
    for (const row of rows) {
      if (typeof row?.id !== 'string' || row.id.length === 0) continue
      if (this.#freeOnly && !isFreeModel(row.id)) continue
      ids.push(row.id)
    }
    this.#counts.openrouterFree = ids.length
    if (ids.length === 0) return []
    const enriched = await this.#enrich(ids).catch(() => undefined)
    return ids.map((id) => ({ ...(enriched?.get(id) ?? { id }), source: 'openrouter' as const }))
  }

  /**
   * Best-effort OpenRouter metadata: display name, context window, max
   * output, image input. Cline's OpenRouter ids are verbatim OpenRouter ids,
   * so the join is exact; any failure only costs the enrichment.
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
        name?: string
        context_length?: number
        top_provider?: { max_completion_tokens?: number | null }
        architecture?: { input_modalities?: string[] }
      }>
    }
    const map = new Map<string, CatalogEntry>()
    for (const row of body.data ?? []) {
      if (typeof row?.id !== 'string' || !wanted.has(row.id)) continue
      const entry: CatalogEntry = { id: row.id }
      if (typeof row.name === 'string' && row.name.length > 0) entry.name = row.name
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
    this.#ordered = [...next.values()].sort((a, b) => this.#compare(a, b)).map((entry) => entry.id)
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
