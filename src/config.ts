import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 */
export interface Cline2dshConfig {
  /** Provider route name registered into dsh-llm (the model picker column). */
  providerId?: string
  /** Cline OpenAI-compatible API base. */
  baseURL?: string
  /**
   * Path to the Cline desktop credentials file. Empty = the default
   * `~/.cline/data/settings/providers.json` (env `CLINE_HOME` overrides the
   * home part). Set it only when Cline stores its data elsewhere.
   */
  credentialsPath?: string
  /** Model catalog refresh interval in seconds. */
  refreshSeconds?: number
  /** Only expose models whose id carries the `:free` suffix (default true). */
  freeOnly?: boolean
  /** Watchdog: ms to wait for the first stream event. */
  firstEventMs?: number
  /** Watchdog: ms of body silence tolerated mid-stream. */
  bodyIdleMs?: number
}

export const defaults = {
  providerId: 'cline2dsh',
  baseURL: 'https://api.cline.bot/api/v1',
  credentialsPath: '',
  refreshSeconds: 300,
  freeOnly: true,
}

export type ResolvedConfig = Required<
  Pick<Cline2dshConfig, 'providerId' | 'baseURL' | 'credentialsPath' | 'refreshSeconds' | 'freeOnly'>
> & Pick<Cline2dshConfig, 'firstEventMs' | 'bodyIdleMs'>

export function resolveConfig(config: Cline2dshConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}

/**
 * The plugin's `Config` — the DSH settings contract. Everything here is
 * ordinary composition configuration (set via cordis.patch.yml), so no
 * `.volatile()` node: the settings card stays read-only for these fields.
 */
export const Config = Schema.object({
  providerId: Schema.string().default(defaults.providerId),
  baseURL: Schema.string().default(defaults.baseURL),
  credentialsPath: Schema.string().default(defaults.credentialsPath),
  refreshSeconds: Schema.number().step(1).min(30).default(defaults.refreshSeconds),
  freeOnly: Schema.boolean().default(defaults.freeOnly),
  firstEventMs: Schema.number().step(1).min(1_000).max(600_000),
  bodyIdleMs: Schema.number().step(1).min(1_000).max(600_000),
})
