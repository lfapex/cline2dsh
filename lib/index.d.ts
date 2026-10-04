import Schema from "@deepseek-ai/schemastery";

//#region src/config.d.ts

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 */
interface Cline2dshConfig {
  /** Provider route name registered into dsh-llm (the model picker column). */
  providerId?: string;
  /** Cline OpenAI-compatible API base. */
  baseURL?: string;
  /**
   * Path to the Cline desktop credentials file. Empty = the default
   * `~/.cline/data/settings/providers.json` (env `CLINE_HOME` overrides the
   * home part). Set it only when Cline stores its data elsewhere.
   */
  credentialsPath?: string;
  /** Model catalog refresh interval in seconds. */
  refreshSeconds?: number;
  /** Only expose free models (default true). */
  freeOnly?: boolean;
  /**
   * Also expose the Cline Pass bucket (recommended-models endpoint). These
   * need a Cline Pass subscription — without one every request 403s with
   * ENTITLEMENT_ERROR, so this defaults to false.
   */
  includeClinePass?: boolean;
  /** Watchdog: ms to wait for the first stream event. */
  firstEventMs?: number;
  /** Watchdog: ms of body silence tolerated mid-stream. */
  bodyIdleMs?: number;
}
type ResolvedConfig = Required<Pick<Cline2dshConfig, 'providerId' | 'baseURL' | 'credentialsPath' | 'refreshSeconds' | 'freeOnly' | 'includeClinePass'>> & Pick<Cline2dshConfig, 'firstEventMs' | 'bodyIdleMs'>;
declare function resolveConfig(config?: Cline2dshConfig): ResolvedConfig;
/**
 * The plugin's `Config` — the DSH settings contract. Everything here is
 * ordinary composition configuration (set via cordis.patch.yml), so no
 * `.volatile()` node: the settings card stays read-only for these fields.
 */
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
  providerId: Schema<string, string, "defined">;
  baseURL: Schema<string, string, "defined">;
  credentialsPath: Schema<string, string, "defined">;
  refreshSeconds: Schema<number, number, "defined">;
  freeOnly: Schema<boolean, boolean, "defined">;
  includeClinePass: Schema<boolean, boolean, "defined">;
  firstEventMs: Schema<number, number, "plain">;
  bodyIdleMs: Schema<number, number, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
  providerId: Schema<string, string, "defined">;
  baseURL: Schema<string, string, "defined">;
  credentialsPath: Schema<string, string, "defined">;
  refreshSeconds: Schema<number, number, "defined">;
  freeOnly: Schema<boolean, boolean, "defined">;
  includeClinePass: Schema<boolean, boolean, "defined">;
  firstEventMs: Schema<number, number, "plain">;
  bodyIdleMs: Schema<number, number, "plain">;
}>>, "plain">;
//#endregion
//#region src/catalog.d.ts
interface CatalogSnapshot {
  status: 'live' | 'cache' | 'static' | 'pending';
  total: number;
  exposed: number;
  freeBucket: number;
  clinePass: number;
  openrouterFree: number;
  fetchedAt?: string;
}
declare function defaultCachePath(dataDir: string): string;
declare function defaultDataDir(): string;
declare class ModelCatalog {
  #private;
  constructor(options: {
    baseURL: string;
    credentialsPath: string;
    cachePath: string;
    refreshSeconds: number;
    freeOnly: boolean;
    includeClinePass?: boolean;
    fetchImpl?: typeof fetch;
    onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void;
  });
  list(): string[];
  display(model: string): string;
  snapshot(): CatalogSnapshot;
  limits(model: string): {
    contextWindow?: number;
    maxOutput?: number;
  } | undefined;
  modalities(model: string): string[] | undefined;
  /** Initial cache read (tier 2); never throws. Returns a startup note or ''. */
  prime(): Promise<string>;
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<void>;
}
//#endregion
//#region src/events.d.ts
/**
 * pi-ai AssistantMessageEvent -> harness StreamChunks. Clean-room port of
 * dsh-llm-pi-ai's toStreamChunks (verified against opencode2dsh's copy, which
 * was verified against the host source): the chunk stream must end with
 * `usage` then `finish`.
 */
type HarnessChunk = {
  type: 'block-start';
  index: number;
  blockType: 'text' | 'reasoning' | 'tool-call';
} | {
  type: 'text-delta';
  index: number;
  text: string;
} | {
  type: 'block-end';
  index: number;
  block: {
    type: 'text';
    text: string;
  } | {
    type: 'reasoning';
    text: string;
  } | {
    type: 'tool-call';
    id: string;
    name: string;
    arguments: string;
  };
} | {
  type: 'reasoning-delta';
  index: number;
  text: string;
} | {
  type: 'tool-call-delta';
  index: number;
  id: string;
  name?: string;
  argumentsDelta: string;
} | {
  type: 'usage';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
} | {
  type: 'finish';
  reason: FinishReason;
  replayState?: unknown;
};
type FinishReason = {
  kind: 'stop';
} | {
  kind: 'max-tokens';
} | {
  kind: 'tool-calls';
} | {
  kind: 'aborted';
  failure: {
    message: string;
    code: string;
  };
} | {
  kind: 'error';
  failure: {
    message: string;
    code: string;
  };
};
//#endregion
//#region src/messages.d.ts
/**
 * Harness GenerateOptions -> pi-ai Context conversion (clean-room port of
 * dsh-llm-pi-ai's textOnlyContext via opencode2dsh). User and tool-result
 * image blocks are kept: when the catalog declares image input the adapter
 * advertises it, and the bytes load from the harness attachment store here.
 */
interface HarnessTool {
  name: string;
  description: string;
  parameters: unknown;
}
type HarnessBlock = {
  type: 'text';
  text: string;
} | {
  type: 'reasoning';
  text: string;
} | {
  type: 'tool-call';
  id: string;
  name: string;
  arguments: string;
} | {
  type: 'image';
  [key: string]: unknown;
} | {
  type: 'tool-result';
  toolCallId: string;
  content: HarnessBlock[];
  isError?: boolean;
  [key: string]: unknown;
};
interface HarnessMessage {
  role: 'system' | 'user' | 'assistant';
  content: HarnessBlock[];
  source?: {
    kind: string;
    provider?: string;
    model?: string;
    callId?: string;
    [key: string]: unknown;
  };
}
interface HarnessGenerateOptions {
  provider: string;
  model: string;
  messages: HarnessMessage[];
  system?: string;
  tools?: HarnessTool[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}
//#endregion
//#region src/adapter.d.ts
/**
 * The cline2dsh adapter: registers as a DSH LlmAdapter for the `cline2dsh`
 * route and streams from Cline's OpenAI-compatible backend
 * (api.cline.bot/api/v1) with the locally logged-in Cline account's OAuth
 * token. Free models only by default (`:free` ids). The wire layer is pi-ai's
 * openai-completions — the same one DSH uses for every OpenAI-compatible
 * provider; this module adds the credential injection, the Cline attribution
 * headers, and the free-model catalog.
 *
 * Adapter contract: dsh-llm LlmAdapter (providerInfo/listModels/resolveModel/
 * prepareCall/stream) — structural, no host import.
 */
declare const PROVIDER_ID = "cline2dsh";
declare class ClineAdapter {
  #private;
  constructor(catalog: ModelCatalog, options: {
    baseURL: string;
    credentialsPath: string;
    firstEventMs?: number;
    bodyIdleMs?: number;
    providerOverride?: unknown;
  });
  providerInfo(provider: string): {
    id: string;
    name: string;
  };
  /** undefined = the host default retry policy. */
  providerRetryPolicy(_provider: string): undefined;
  imageRequestPricing(_provider: string, _model: string): undefined;
  /** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
  listModels(provider: string): Array<{
    provider: string;
    id: string;
    name: string;
    inputModalities: string[];
  }>;
  resolveModel(provider: string, model: string): {
    provider: string;
    id: string;
    name: string;
    inputModalities: string[];
    context: {
      contextWindow: number;
    };
    defaultMaxTokens: number;
  };
  prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<ClineAdapter['resolveModel']>;
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>;
  }>;
  /**
   * Stream one completion. Single upstream attempt per call — retry policy is
   * the host's job — but with the same stream-liveness watchdogs as
   * opencode2dsh: neither fetch nor pi-ai owns a body-silence timeout, so a
   * tunnel that connects but never streams would hang the turn forever.
   */
  stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk>;
}
//#endregion
//#region src/credentials.d.ts
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
interface ClineCredentials {
  /** Verbatim persisted access token (`workos:...` JWT); sent as Bearer. */
  accessToken: string;
  /** Reusable refresh token; the backend does NOT rotate it (verified). */
  refreshToken?: string;
  /** Cline account id (`usr-...`); sent as the `clineUserId` header. */
  accountId: string;
  /** Epoch ms the access token expires at, when the file declares one. */
  expiresAt?: number;
}
/**
 * Read and validate the Cline provider credentials. Throws CredentialsError
 * with a user-actionable message on any missing/malformed shape.
 */
declare function readClineCredentials(path?: string): Promise<ClineCredentials>;
declare function readClineCredentialsCached(path?: string): Promise<ClineCredentials>;
/**
 * Token refresh against the Cline backend (`POST /api/v1/auth/refresh`,
 * body `{refreshToken, grantType: "refresh_token"}` — reverse-engineered
 * from the Cline extension, live-verified 2026-10-04). The backend does NOT
 * rotate the refresh token (the response echoes the same one the desktop
 * app keeps reusing), so refreshing here never kicks the desktop app out
 * of its session. The minted token lives only in this process's memory —
 * providers.json stays the desktop app's property.
 */
declare function refreshClineToken(baseURL: string, creds: ClineCredentials): Promise<ClineCredentials>;
interface ValidToken {
  accessToken: string;
  accountId: string;
  /** True when this call minted a fresh token via the refresh endpoint. */
  refreshed: boolean;
}
/**
 * Access token for one API call, refreshing proactively when the current
 * token is at (or past) its expiry. Reads the desktop app's file for the
 * base state; refreshed tokens stay in memory only. When refresh fails but
 * a token exists, the stale token is returned — the API call it arms may
 * still succeed (clock skew) or surface a precise 401 upstream.
 */
declare function getValidAccessToken(options: {
  baseURL: string;
  credentialsPath: string;
}): Promise<ValidToken>;
//#endregion
//#region src/index.d.ts
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
interface PluginContext {
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  llm?: {
    registerAdapter(providers: string[], adapter: unknown): unknown;
  };
  effect?(fn: () => () => void): unknown;
}
declare const name = "cline2dsh";
/** Only `llm` gates this fiber: the adapter needs nothing else. */
declare const inject: readonly ["llm"];
declare function apply(ctx: PluginContext, config?: Cline2dshConfig): void;
//#endregion
export { type Cline2dshConfig, ClineAdapter, Config, ModelCatalog, PROVIDER_ID, PluginContext, apply, defaultCachePath, defaultDataDir, getValidAccessToken, inject, name, readClineCredentials, readClineCredentialsCached, refreshClineToken, resolveConfig };