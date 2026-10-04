import { createProvider, type Api, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'

import type { CatalogEntry, ModelCatalog } from './catalog.ts'
import { clineRequestHeaders, readClineCredentialsCached } from './credentials.ts'
import { toStreamChunks, type HarnessChunk, type PiDoneMessage, type PiEvent } from './events.ts'
import { deriveRequestIDs } from './ids.ts'
import { toPiContext, type HarnessGenerateOptions, type PiContext } from './messages.ts'

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

export const PROVIDER_ID = 'cline2dsh'

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

export const DEFAULT_FIRST_EVENT_MS = 30_000
export const DEFAULT_BODY_IDLE_MS = 120_000

const WATCHDOG_FIRST_MESSAGE = 'cline2dsh: first stream event timeout (upstream silent before any response)'
const WATCHDOG_IDLE_MESSAGE = 'cline2dsh: stream body idle timeout (upstream went silent mid-response)'

function contextWindowFor(entry: CatalogEntry | undefined): number {
  const declared = entry?.contextWindow
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
}

function maxTokensFor(entry: CatalogEntry | undefined): number {
  const declared = entry?.maxOutput
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS
}

function inputModalitiesFor(entry: CatalogEntry | undefined): Array<'text' | 'image'> {
  return entry?.input?.includes('image') ? ['text', 'image'] : ['text']
}

function toPiModel(id: string, baseURL: string, entry: CatalogEntry | undefined): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: baseURL.replace(/\/+$/, ''),
    reasoning: false,
    input: inputModalitiesFor(entry),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowFor(entry),
    maxTokens: maxTokensFor(entry),
  }
}

function terminalErrorEvent(errorMessage: string, model: Model<Api>): PiEvent {
  return {
    type: 'error',
    error: {
      api: model.api ?? 'openai-completions',
      provider: PROVIDER_ID,
      model: model.id,
      content: [],
      stopReason: 'error',
      errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
  }
}

function flattenText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

export class ClineAdapter {
  readonly #catalog: ModelCatalog
  readonly #baseURL: string
  readonly #credentialsPath: string
  readonly #firstEventMs: number
  readonly #bodyIdleMs: number
  readonly #provider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown }

  constructor(
    catalog: ModelCatalog,
    options: {
      baseURL: string
      credentialsPath: string
      firstEventMs?: number
      bodyIdleMs?: number
      providerOverride?: unknown
    },
  ) {
    this.#catalog = catalog
    this.#baseURL = options.baseURL.replace(/\/+$/, '')
    this.#credentialsPath = options.credentialsPath
    this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS
    this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS
    if (options.providerOverride !== undefined) {
      this.#provider = options.providerOverride as never
      return
    }
    this.#provider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl: this.#baseURL,
      auth: {
        apiKey: {
          name: 'Cline account token',
          resolve: async () => {
            const creds = await readClineCredentialsCached(this.#credentialsPath || undefined)
            return { auth: { apiKey: creds.accessToken } }
          },
        },
      },
      models: [],
      api: openaiCompletions,
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_ID }
  }

  /** undefined = the host default retry policy. */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    const seen = new Set<string>()
    const models: Array<{ provider: string; id: string; name: string; inputModalities: string[] }> = []
    for (const id of this.#catalog.list()) {
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ provider, id, name: this.#catalog.display(id), inputModalities: inputModalitiesFor(this.#entryFor(id)) })
    }
    return models
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
  } {
    const entry = this.#entryFor(model)
    return {
      provider,
      id: model,
      name: this.#catalog.display(model),
      inputModalities: inputModalitiesFor(entry),
      context: { contextWindow: contextWindowFor(entry) },
      defaultMaxTokens: maxTokensFor(entry),
    }
  }

  async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<ClineAdapter['resolveModel']>
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>
  }> {
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Stream one completion. Single upstream attempt per call — retry policy is
   * the host's job — but with the same stream-liveness watchdogs as
   * opencode2dsh: neither fetch nor pi-ai owns a body-silence timeout, so a
   * tunnel that connects but never streams would hang the turn forever.
   */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const context: PiContext = await toPiContext(options)
    const firstUser = options.messages.find((message) => message.role === 'user')
    const ids = deriveRequestIDs({
      model: options.model,
      system: typeof options.system === 'string' ? options.system : undefined,
      firstMessageText: firstUser ? flattenText(firstUser.content as Array<{ type: string; text?: string }>) : undefined,
    })
    const model = toPiModel(options.model, this.#baseURL, this.#entryFor(options.model))
    const creds = await readClineCredentialsCached(this.#credentialsPath || undefined)
    const headers = clineRequestHeaders(creds)

    const events = this.#provider.streamSimple(model, context as unknown as never, {
      apiKey: creds.accessToken,
      sessionId: ids.session,
      headers,
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    }) as AsyncIterable<PiEvent>

    yield* this.#withWatchdogs(events, model)
  }

  #entryFor(model: string): CatalogEntry | undefined {
    const limits = this.#catalog.limits(model)
    return limits ? { id: model, ...limits } : undefined
  }

  /**
   * Watchdog wrapper. FIRST-EVENT window until the first pi-ai event lands
   * (connect stage should answer within seconds); BODY-IDLE window once
   * events flow (minutes of mid-stream silence is a dead tunnel, not
   * pacing). Timeout-promise racing is the only mechanism that actually
   * interrupts a hung next().
   */
  async *#withWatchdogs(events: AsyncIterable<PiEvent>, model: Model<Api>): AsyncGenerator<HarnessChunk> {
    const source = events[Symbol.asyncIterator]()
    const buffered: PiEvent[] = []
    let sawAnyEvent = false
    let lastEventAt = Date.now()
    let deadlineTimer: NodeJS.Timeout | undefined
    const self = this
    // One deadline timer at a time, re-armed per pull (a timer per pull would
    // accumulate thousands over a long token stream). While no event has
    // arrived at all, the FIRST-EVENT window applies; once ANY event has
    // landed, the looser BODY-IDLE window applies.
    const raceDeadline = (): Promise<never> => {
      clearTimeout(deadlineTimer)
      const window = sawAnyEvent ? self.#bodyIdleMs : self.#firstEventMs
      const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE
      const ms = Math.max(0, window - (Date.now() - lastEventAt))
      return new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error(message)), ms)
        deadlineTimer.unref?.()
      })
    }

    // Peek phase: buffer events until the stream proves itself one way or
    // the other — terminal (done/error) stays buffered and passes through
    // untouched; first non-terminal event (content flowing) flushes into the
    // live pump so the UI streams immediately.
    for (;;) {
      let next: IteratorResult<PiEvent>
      try {
        next = await Promise.race([source.next(), raceDeadline()])
      } catch (err) {
        buffered.push(terminalErrorEvent(err instanceof Error ? err.message : String(err), model))
        break
      }
      if (next.done) break
      const event = next.value as PiEvent
      lastEventAt = Date.now()
      sawAnyEvent = true
      buffered.push(event)
      if (event.type === 'done' || event.type === 'error') break
      if (event.type !== 'start') break
    }
    clearTimeout(deadlineTimer)

    if (!sawAnyEvent) {
      // stream ended cleanly with no events at all
      yield* toStreamChunks((async function* () {})(), model.contextWindow)
      return
    }

    const terminal = buffered[buffered.length - 1]
    if (terminal?.type === 'done' || terminal?.type === 'error') {
      yield* toStreamChunks(
        (async function* () {
          for (const e of buffered) yield e
        })(),
        model.contextWindow,
      )
      return
    }

    // Live pump: buffered events first, then the live rest of the stream,
    // through ONE toStreamChunks pass so the done/error terminator is never
    // missing.
    async function* pumpLive(): AsyncGenerator<PiEvent> {
      let timer: NodeJS.Timeout | undefined
      try {
        for (const e of buffered) yield e
        for (;;) {
          let next: IteratorResult<PiEvent>
          try {
            const window = self.#bodyIdleMs
            const ms = Math.max(0, window - (Date.now() - lastEventAt))
            const deadline = new Promise<never>((_, reject) => {
              clearTimeout(timer)
              timer = setTimeout(() => reject(new Error(WATCHDOG_IDLE_MESSAGE)), ms)
              timer.unref?.()
            })
            next = await Promise.race([source.next(), deadline])
          } catch (err) {
            // watchdog or teardown tore the stream down mid-content: surface
            // the terminal error honestly — never a hang, never a replay
            yield terminalErrorEvent(err instanceof Error ? err.message : String(err), model)
            return
          }
          if (next.done) return
          const event = next.value as PiEvent
          lastEventAt = Date.now()
          yield event
          if (event.type === 'done' || event.type === 'error') return
        }
      } finally {
        clearTimeout(timer)
      }
    }

    yield* toStreamChunks(pumpLive(), model.contextWindow)
  }
}
