import { ClineAdapter, PROVIDER_ID } from './adapter.ts'
import { defaultCachePath, defaultDataDir, ModelCatalog } from './catalog.ts'
import { Config, resolveConfig, type Cline2dshConfig, type ResolvedConfig } from './config.ts'
import { defaultCredentialsPath, readClineCredentialsCached } from './credentials.ts'

/**
 * cline2dsh DSH cordis plugin entry.
 *
 * Registers a DSH LlmAdapter that streams from Cline's OpenAI-compatible
 * backend with the locally logged-in Cline account's token, free models
 * only. The model catalog warms up in the background (live /models ->
 * 7-day disk cache -> compiled-in static roster), so the provider shows up
 * in the picker immediately.
 *
 * The adapter never refreshes the OAuth token itself: Cline desktop owns the
 * refresh cycle (rotating refresh tokens make concurrent refreshers kick
 * each other out), so the plugin only reads what the app last persisted.
 * When the token expires, open the Cline desktop app once.
 *
 * dispose(): stop the catalog timers. The cordis fiber disposal guarantees
 * this runs on plugin reload/unload and on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin
// independent of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  effect?(fn: () => () => void): unknown
}

export const name = 'cline2dsh'

/**
 * The plugin's settings schema. DSH reads this export to decide which fields
 * are editable under this entry's Loader id, so it must be named `Config`.
 */
export { Config }

/** Only `llm` gates this fiber: the adapter needs nothing else. */
export const inject = ['llm'] as const

export function apply(ctx: PluginContext, config: Cline2dshConfig = {}): void {
  const logger = ctx.logger
  const cfg: ResolvedConfig = resolveConfig(config)
  const credentialsPath = cfg.credentialsPath.length > 0 ? cfg.credentialsPath : defaultCredentialsPath()

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('cline2dsh: llm service unavailable; adapter cannot register')
    return
  }

  const dataDir = defaultDataDir()
  const catalog = new ModelCatalog({
    baseURL: cfg.baseURL,
    credentialsPath,
    cachePath: defaultCachePath(dataDir),
    refreshSeconds: cfg.refreshSeconds,
    freeOnly: cfg.freeOnly,
    onRefresh: (status, lastError) => {
      if (lastError) logger.warn(`cline2dsh: catalog refresh issue (${status.status}): ${lastError}`)
      else logger.info(`cline2dsh: catalog ${status.status} (${status.exposed} free models)`)
    },
  })
  const adapter = new ClineAdapter(catalog, {
    baseURL: cfg.baseURL,
    credentialsPath,
    firstEventMs: cfg.firstEventMs,
    bodyIdleMs: cfg.bodyIdleMs,
  })

  // Register FIRST: the provider must appear in the selector right away,
  // even while the catalog is still warming up. A throw anywhere below must
  // never cost the deployment its provider.
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`cline2dsh: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`)

  // Startup credential probe: surface a missing/expired Cline session as a
  // clear warning now instead of a per-request failure later.
  void readClineCredentialsCached(credentialsPath)
    .then((creds) => {
      const expires = creds.expiresAt ? `; token expires ${new Date(creds.expiresAt).toISOString()}` : ''
      logger.info(`cline2dsh: Cline credentials found (account ${creds.accountId.slice(0, 12)}…)${expires}`)
    })
    .catch((err: Error) => {
      logger.warn(`${err.message}`)
    })

  void catalog.start().catch((err) => {
    logger.error(`cline2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      catalog.stop()
    })
  }
}

export { ClineAdapter, PROVIDER_ID } from './adapter.ts'
export { defaultCachePath, defaultDataDir, ModelCatalog } from './catalog.ts'
export { resolveConfig, type Cline2dshConfig } from './config.ts'
export { readClineCredentials, readClineCredentialsCached } from './credentials.ts'
