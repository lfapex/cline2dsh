import { createProvider } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";

//#region src/credentials.ts
var CredentialsError = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/** Env override for the Cline home, mirroring the desktop app's layout. */
function defaultCredentialsPath() {
	const clineHome = process.env.CLINE_HOME?.trim();
	return join(clineHome && clineHome.length > 0 ? clineHome : join(homedir(), ".cline"), "data", "settings", "providers.json");
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Read and validate the Cline provider credentials. Throws CredentialsError
* with a user-actionable message on any missing/malformed shape.
*/
async function readClineCredentials(path = defaultCredentialsPath()) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		const code = err?.code === "ENOENT" ? "CLINE_NOT_INSTALLED" : "CLINE_UNREADABLE";
		throw new CredentialsError(`cline2dsh: cannot read Cline credentials at ${path} (${err.message}). Open the Cline desktop app and log in once, then retry.`, code);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CredentialsError(`cline2dsh: ${path} is not valid JSON (Cline may be mid-write); retry shortly.`, "CLINE_MALFORMED");
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) throw new CredentialsError(`cline2dsh: unexpected providers.json shape at ${path}.`, "CLINE_MALFORMED");
	const cline = parsed.providers.cline;
	const settings = isRecord(cline) ? cline.settings : void 0;
	const authBlock = isRecord(settings) ? settings.auth : void 0;
	if (!isRecord(cline) || !isRecord(authBlock)) throw new CredentialsError("cline2dsh: no Cline account session found in providers.json. Open the Cline desktop app, sign in (Cline provider), then retry.", "CLINE_NOT_LOGGED_IN");
	const accessToken = authBlock.accessToken;
	const refreshToken = authBlock.refreshToken;
	const accountId = authBlock.accountId ?? (isRecord(authBlock.metadata) ? authBlock.metadata?.userInfo?.clineUserId : void 0);
	if (typeof accessToken !== "string" || accessToken.length === 0) throw new CredentialsError("cline2dsh: providers.json has no accessToken; log in from the Cline desktop app.", "CLINE_NOT_LOGGED_IN");
	if (typeof accountId !== "string" || accountId.length === 0) throw new CredentialsError("cline2dsh: providers.json has no accountId/clineUserId; log in from the Cline desktop app.", "CLINE_NOT_LOGGED_IN");
	const expiresAtRaw = authBlock.expiresAt;
	return {
		accessToken,
		accountId,
		expiresAt: typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw) ? expiresAtRaw : void 0,
		...typeof refreshToken === "string" && refreshToken.length > 0 ? { refreshToken } : {}
	};
}
/**
* Headers the Cline desktop client itself sends. Two layers matter:
*  - attribution (HTTP-Referer / X-Title) and the account binding
*    (clineUserId), matching the desktop client;
*  - client identity (X-CLIENT-TYPE / X-CLIENT-VERSION / X-PLATFORM) — the
*    `cline-free/*` routing prefix is gated on these ("only available via
*    Cline product surfaces", live-verified 2026-10-04: plain Bearer alone
*    gets 403, the full identity set gets 200).
*/
const CLINE_CLIENT_TYPE = process.env.CLINE_CLIENT_TYPE?.trim() || "cline-sdk";
const CLINE_CLIENT_VERSION = process.env.CLINE_CLIENT_VERSION?.trim() || "4.1.22";
function clineRequestHeaders(accountId) {
	return {
		clineUserId: accountId,
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
		"X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
		"X-PLATFORM": CLINE_CLIENT_TYPE,
		"X-PLATFORM-VERSION": CLINE_CLIENT_VERSION,
		"User-Agent": `Cline/${CLINE_CLIENT_VERSION}`
	};
}
let cache;
let cachePath = "";
async function readClineCredentialsCached(path = defaultCredentialsPath()) {
	if (cache && cachePath === path) try {
		const { mtimeMs } = await stat(path);
		if (mtimeMs === cache.mtimeMs) return cache.creds;
	} catch {}
	const creds = await readClineCredentials(path);
	try {
		const { mtimeMs } = await stat(path);
		cache = {
			mtimeMs,
			creds
		};
		cachePath = path;
	} catch {
		cache = void 0;
	}
	return creds;
}
/**
* Token refresh against the Cline backend (`POST /api/v1/auth/refresh`,
* body `{refreshToken, grantType: "refresh_token"}` — reverse-engineered
* from the Cline extension, live-verified 2026-10-04). The backend does NOT
* rotate the refresh token (the response echoes the same one the desktop
* app keeps reusing), so refreshing here never kicks the desktop app out
* of its session. The minted token lives only in this process's memory —
* providers.json stays the desktop app's property.
*/
async function refreshClineToken(baseURL, creds) {
	if (!creds.refreshToken) throw new CredentialsError("cline2dsh: no refreshToken in providers.json; open the Cline desktop app and log in again.", "CLINE_NO_REFRESH_TOKEN");
	const url = `${baseURL.replace(/\/+$/, "")}/auth/refresh`;
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...clineRequestHeaders(creds.accountId)
			},
			body: JSON.stringify({
				refreshToken: creds.refreshToken,
				grantType: "refresh_token"
			}),
			signal: AbortSignal.timeout(2e4)
		});
	} catch (err) {
		throw new CredentialsError(`cline2dsh: token refresh request failed: ${err.message}`, "CLINE_REFRESH_TRANSPORT");
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		if (response.status === 401 || response.status === 403) throw new CredentialsError("cline2dsh: token refresh rejected (401/403) — the Cline session was revoked. Open the Cline desktop app and log in again.", "CLINE_REFRESH_REJECTED");
		throw new CredentialsError(`cline2dsh: token refresh -> ${response.status} ${text.slice(0, 160)}`, "CLINE_REFRESH_FAILED");
	}
	const body = await response.json();
	const inner = isRecord(body.data) ? body.data : body;
	const accessToken = typeof inner.accessToken === "string" ? inner.accessToken : void 0;
	if (!accessToken) throw new CredentialsError("cline2dsh: token refresh response had no accessToken.", "CLINE_REFRESH_FAILED");
	const rawExpiry = inner.expiresAt;
	let expiresAt;
	if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) expiresAt = rawExpiry < 0xe8d4a51000 ? rawExpiry * 1e3 : rawExpiry;
	else if (typeof rawExpiry === "string" && rawExpiry.length > 0) {
		const parsed = Date.parse(rawExpiry);
		if (Number.isFinite(parsed)) expiresAt = parsed;
	}
	return {
		...creds,
		accessToken,
		expiresAt
	};
}
const EXPIRY_MARGIN_MS = 6e4;
/** In-memory refreshed tokens, keyed by resolved credentials path. */
const liveTokens = /* @__PURE__ */ new Map();
/** Single-flight refresh per path; concurrent callers share one request. */
const pendingRefreshes = /* @__PURE__ */ new Map();
/**
* Access token for one API call, refreshing proactively when the current
* token is at (or past) its expiry. Reads the desktop app's file for the
* base state; refreshed tokens stay in memory only. When refresh fails but
* a token exists, the stale token is returned — the API call it arms may
* still succeed (clock skew) or surface a precise 401 upstream.
*/
async function getValidAccessToken(options) {
	const key = options.credentialsPath || defaultCredentialsPath();
	const creds = await readClineCredentialsCached(key);
	const live = liveTokens.get(key);
	const token = live?.accessToken ?? creds.accessToken;
	const expiresAt = live?.expiresAt ?? creds.expiresAt;
	if (token && (expiresAt === void 0 || Date.now() < expiresAt - EXPIRY_MARGIN_MS)) return {
		accessToken: token,
		accountId: creds.accountId,
		refreshed: false
	};
	let refreshedCreds;
	if (creds.refreshToken) {
		let pending = pendingRefreshes.get(key);
		if (!pending) {
			pending = refreshClineToken(options.baseURL, creds).finally(() => {
				pendingRefreshes.delete(key);
			});
			pendingRefreshes.set(key, pending);
		}
		try {
			refreshedCreds = await pending;
			liveTokens.set(key, refreshedCreds);
		} catch {}
	}
	if (refreshedCreds) return {
		accessToken: refreshedCreds.accessToken,
		accountId: refreshedCreds.accountId,
		refreshed: true
	};
	if (token) return {
		accessToken: token,
		accountId: creds.accountId,
		refreshed: false
	};
	throw new CredentialsError("cline2dsh: no usable Cline token; open the Cline desktop app and log in.", "CLINE_NOT_LOGGED_IN");
}

//#endregion
//#region src/events.ts
const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";
const EMPTY_RESPONSE = "EMPTY_RESPONSE";
const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
function classifyError(text) {
	if (/\bRegionError\b|not available in your country/i.test(text)) return "REGION_BLOCKED";
	if (/\b(?:401|403)\b/.test(text)) return "AUTH";
	if (/insufficient|quota|billing|credit/i.test(text)) return QUOTA_EXCEEDED;
	if (/\b429\b|rate.?limit/i.test(text)) return "RATE_LIMIT";
	if (/\b413\b|payload too large|request body too large/i.test(text)) return "INVALID_REQUEST";
	if (/\b400\b|invalid.?request/i.test(text)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(text)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "TIMEOUT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return "TRANSPORT";
	return "UPSTREAM";
}
function isContextOverflow(message, contextWindow) {
	return message.stopReason === "stop" && message.usage.input > contextWindow;
}
/** mapStopReason (dsh-llm-pi-ai index.js:1286-1330). */
function mapStopReason(message, contextWindow) {
	if (isContextOverflow(message, contextWindow) || message.stopReason === "error" && message.errorMessage !== void 0 && /context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage)) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": return {
			kind: "error",
			failure: {
				message: message.errorMessage ?? "pi-ai stream error",
				code: classifyError(message.errorMessage ?? "")
			}
		};
	}
}
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
/**
* Translate one pi-ai event stream into harness chunks. pi-ai never throws
* mid-stream: failures arrive as `error` events and become error/aborted
* finish chunks.
*/
async function* toStreamChunks(events, contextWindow) {
	const toolIds = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id ?? "" : "";
			const name$1 = partial?.type === "toolCall" ? partial.name ?? "" : "";
			toolIds.set(event.contentIndex, {
				id,
				name: name$1
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: known?.id ?? "",
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: event.toolCall.id,
					name: event.toolCall.name,
					arguments: JSON.stringify(event.toolCall.arguments)
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error, contextWindow)
			};
			return;
	}
	throw new Error("cline2dsh: pi-ai event stream ended without done/error");
}

//#endregion
//#region src/ids.ts
function hashParts(...parts) {
	const h = createHash("sha256");
	for (const part of parts) {
		h.update(part ?? "\0");
		h.update("");
	}
	return h.digest("hex");
}
function deriveRequestIDs(options) {
	return {
		session: hashParts(options.model, options.system, options.firstMessageText).slice(0, 32),
		request: randomUUID()
	};
}

//#endregion
//#region src/messages.ts
function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function parseArguments(raw) {
	if (typeof raw !== "string" || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
	} catch {
		return { raw };
	}
}
/**
* Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
* DSH_HOME is always set by the harness child; the homedir fallback covers
* direct invocation (tests, tooling).
*/
function dshHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured) return configured;
	return join(homedir(), ".dsh");
}
async function toPiImage(ref) {
	const attachment = ref ?? {};
	const id = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
	const sha = id.startsWith("sha256:") ? id.slice(7) : id;
	if (!/^[0-9a-f]{64}$/.test(sha)) return {
		type: "text",
		text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]`
	};
	const path = join(dshHome(), "attachments", "v1", "objects", sha.slice(0, 2), sha);
	try {
		return {
			type: "image",
			data: (await readFile(path)).toString("base64"),
			mimeType: typeof attachment.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image/png"
		};
	} catch {
		return {
			type: "text",
			text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]`
		};
	}
}
function offloadedImagePart(ref) {
	const id = ref?.attachmentId;
	return {
		type: "text",
		text: `[image omitted: offloaded to fit the request image budget${typeof id === "string" && id.length > 0 ? ` ${id.slice(0, 30)}` : ""}]`
	};
}
async function imagePart(block) {
	return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment);
}
async function userParts(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") {
		if (block.text.length > 0) parts.push({
			type: "text",
			text: block.text
		});
	} else if (block.type === "image") parts.push(await imagePart(block));
	return parts;
}
async function toolResultParts(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") parts.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") parts.push(await imagePart(block));
	else if (block.type === "tool-result") parts.push(...await toolResultParts(block.content));
	return parts;
}
function toPiAssistant(message, providerId) {
	const content = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning":
			content.push({
				type: "thinking",
				thinking: block.text
			});
			break;
		case "tool-call":
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments)
			});
			break;
		default: break;
	}
	const source = message.source;
	const model = source?.kind === "model" && typeof source.model === "string" ? source.model : providerId;
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: source?.kind === "model" && typeof source.provider === "string" ? source.provider : providerId,
		model,
		usage: zeroUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
function flattenText$1(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* Convert the harness conversation into a pi-ai Context. Async because image
* bytes are read from disk.
*/
async function toPiContext(options) {
	const providerId = options.provider;
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (message.role === "system") {
			const text = flattenText$1(message);
			if (text.length > 0) messages.push({
				role: "user",
				content: text,
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message, providerId);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
			messages.push(assistant);
			continue;
		}
		const parts = await userParts(message.content);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (parts.length > 0 || results.length === 0) {
			const first = parts[0];
			let content;
			if (parts.length === 0) content = "";
			else if (parts.length === 1 && first?.type === "text") content = first.text;
			else content = parts;
			messages.push({
				role: "user",
				content,
				timestamp: 0
			});
		}
		for (const result of results) {
			let rparts = await toolResultParts(result.content);
			const hasImage = rparts.some((part) => part.type === "image");
			const hasText = rparts.some((part) => part.type === "text" && part.text.length > 0);
			if (!hasImage && !hasText) rparts = [{
				type: "text",
				text: "(no output)"
			}];
			messages.push({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: toolNames.get(result.toolCallId) ?? "unknown",
				content: rparts,
				isError: result.isError ?? false,
				timestamp: 0
			});
		}
	}
	const context = { messages };
	if (typeof options.system === "string" && options.system.length > 0) context.systemPrompt = options.system;
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	if (tools && tools.length > 0) context.tools = tools;
	return context;
}

//#endregion
//#region src/adapter.ts
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
const PROVIDER_ID = "cline2dsh";
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_FIRST_EVENT_MS = 3e4;
const DEFAULT_BODY_IDLE_MS = 12e4;
const WATCHDOG_FIRST_MESSAGE = "cline2dsh: first stream event timeout (upstream silent before any response)";
const WATCHDOG_IDLE_MESSAGE = "cline2dsh: stream body idle timeout (upstream went silent mid-response)";
function contextWindowFor(entry) {
	const declared = entry?.contextWindow;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW;
}
function maxTokensFor(entry) {
	const declared = entry?.maxOutput;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS;
}
function inputModalitiesFor(entry) {
	return entry?.input?.includes("image") ? ["text", "image"] : ["text"];
}
function toPiModel(id, baseURL, entry) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: baseURL.replace(/\/+$/, ""),
		reasoning: false,
		input: inputModalitiesFor(entry),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: contextWindowFor(entry),
		maxTokens: maxTokensFor(entry)
	};
}
function terminalErrorEvent(errorMessage, model) {
	return {
		type: "error",
		error: {
			api: model.api ?? "openai-completions",
			provider: PROVIDER_ID,
			model: model.id,
			content: [],
			stopReason: "error",
			errorMessage,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0
			}
		}
	};
}
function flattenText(content) {
	return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
var ClineAdapter = class {
	#catalog;
	#baseURL;
	#credentialsPath;
	#firstEventMs;
	#bodyIdleMs;
	#provider;
	constructor(catalog, options) {
		this.#catalog = catalog;
		this.#baseURL = options.baseURL.replace(/\/+$/, "");
		this.#credentialsPath = options.credentialsPath;
		this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS;
		this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS;
		if (options.providerOverride !== void 0) {
			this.#provider = options.providerOverride;
			return;
		}
		this.#provider = createProvider({
			id: PROVIDER_ID,
			name: PROVIDER_ID,
			baseUrl: this.#baseURL,
			auth: { apiKey: {
				name: "Cline account token",
				resolve: async () => {
					return { auth: { apiKey: (await readClineCredentialsCached(this.#credentialsPath || void 0)).accessToken } };
				}
			} },
			models: [],
			api: openaiCompletions
		});
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: PROVIDER_ID
		};
	}
	/** undefined = the host default retry policy. */
	providerRetryPolicy(_provider) {}
	imageRequestPricing(_provider, _model) {}
	/** Advisory catalog for the DSH model picker (deduped; dsh-llm rejects duplicates). */
	listModels(provider) {
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const id of this.#catalog.list()) {
			if (seen.has(id)) continue;
			seen.add(id);
			models.push({
				provider,
				id,
				name: this.#catalog.display(id),
				inputModalities: inputModalitiesFor(this.#entryFor(id))
			});
		}
		return models;
	}
	resolveModel(provider, model) {
		const entry = this.#entryFor(model);
		return {
			provider,
			id: model,
			name: this.#catalog.display(model),
			inputModalities: inputModalitiesFor(entry),
			context: { contextWindow: contextWindowFor(entry) },
			defaultMaxTokens: maxTokensFor(entry)
		};
	}
	async prepareCall(provider, model, _signal) {
		return {
			model: this.resolveModel(provider, model),
			stream: (options) => this.stream(options)
		};
	}
	/**
	* Stream one completion. Single upstream attempt per call — retry policy is
	* the host's job — but with the same stream-liveness watchdogs as
	* opencode2dsh: neither fetch nor pi-ai owns a body-silence timeout, so a
	* tunnel that connects but never streams would hang the turn forever.
	*/
	async *stream(options) {
		const context = await toPiContext(options);
		const firstUser = options.messages.find((message) => message.role === "user");
		const ids = deriveRequestIDs({
			model: options.model,
			system: typeof options.system === "string" ? options.system : void 0,
			firstMessageText: firstUser ? flattenText(firstUser.content) : void 0
		});
		const model = toPiModel(options.model, this.#baseURL, this.#entryFor(options.model));
		const { accessToken, accountId } = await getValidAccessToken({
			baseURL: this.#baseURL,
			credentialsPath: this.#credentialsPath
		});
		const headers = clineRequestHeaders(accountId);
		const events = this.#provider.streamSimple(model, context, {
			apiKey: accessToken,
			sessionId: ids.session,
			headers,
			signal: options.signal,
			maxRetries: 0,
			temperature: options.temperature,
			maxTokens: options.maxTokens
		});
		yield* this.#withWatchdogs(events, model);
	}
	#entryFor(model) {
		const limits = this.#catalog.limits(model);
		return limits ? {
			id: model,
			...limits
		} : void 0;
	}
	/**
	* Watchdog wrapper. FIRST-EVENT window until the first pi-ai event lands
	* (connect stage should answer within seconds); BODY-IDLE window once
	* events flow (minutes of mid-stream silence is a dead tunnel, not
	* pacing). Timeout-promise racing is the only mechanism that actually
	* interrupts a hung next().
	*/
	async *#withWatchdogs(events, model) {
		const source = events[Symbol.asyncIterator]();
		const buffered = [];
		let sawAnyEvent = false;
		let lastEventAt = Date.now();
		let deadlineTimer;
		const self = this;
		const raceDeadline = () => {
			clearTimeout(deadlineTimer);
			const window = sawAnyEvent ? self.#bodyIdleMs : self.#firstEventMs;
			const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE;
			const ms = Math.max(0, window - (Date.now() - lastEventAt));
			return new Promise((_, reject) => {
				deadlineTimer = setTimeout(() => reject(new Error(message)), ms);
				deadlineTimer.unref?.();
			});
		};
		for (;;) {
			let next;
			try {
				next = await Promise.race([source.next(), raceDeadline()]);
			} catch (err) {
				buffered.push(terminalErrorEvent(err instanceof Error ? err.message : String(err), model));
				break;
			}
			if (next.done) break;
			const event = next.value;
			lastEventAt = Date.now();
			sawAnyEvent = true;
			buffered.push(event);
			if (event.type === "done" || event.type === "error") break;
			if (event.type !== "start") break;
		}
		clearTimeout(deadlineTimer);
		if (!sawAnyEvent) {
			yield* toStreamChunks((async function* () {})(), model.contextWindow);
			return;
		}
		const terminal = buffered[buffered.length - 1];
		if (terminal?.type === "done" || terminal?.type === "error") {
			yield* toStreamChunks((async function* () {
				for (const e of buffered) yield e;
			})(), model.contextWindow);
			return;
		}
		async function* pumpLive() {
			let timer;
			try {
				for (const e of buffered) yield e;
				for (;;) {
					let next;
					try {
						const window = self.#bodyIdleMs;
						const ms = Math.max(0, window - (Date.now() - lastEventAt));
						const deadline = new Promise((_, reject) => {
							clearTimeout(timer);
							timer = setTimeout(() => reject(new Error(WATCHDOG_IDLE_MESSAGE)), ms);
							timer.unref?.();
						});
						next = await Promise.race([source.next(), deadline]);
					} catch (err) {
						yield terminalErrorEvent(err instanceof Error ? err.message : String(err), model);
						return;
					}
					if (next.done) return;
					const event = next.value;
					lastEventAt = Date.now();
					yield event;
					if (event.type === "done" || event.type === "error") return;
				}
			} finally {
				clearTimeout(timer);
			}
		}
		yield* toStreamChunks(pumpLive(), model.contextWindow);
	}
};

//#endregion
//#region src/catalog.ts
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
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 10080 * 60 * 1e3;
/**
* Display-name badge pinned to the Cline free fleet. Some picker surfaces
* re-sort options alphabetically and ignore adapter order; `!` sorts before
* every letter under both code-point and locale collation (tested), so the
* badge pins the fleet to the top in either world. Display-only — the wire
* model id is untouched.
*/
const FLEET_BADGE = "! ";
function fleetDisplayName(raw, id) {
	return FLEET_BADGE + prettifyBucketName(raw, id);
}
/** Verified free roster (free bucket ∪ /models `:free`, 2026-10-04). */
const STATIC_FREE_MODELS = [
	{
		id: "cline-free/deepseek-v4.1-flash",
		name: FLEET_BADGE + "Deepseek-v4.1-Flash",
		source: "cline"
	},
	{
		id: "stealth/space-bunny-alpha",
		name: FLEET_BADGE + "Space Bunny Alpha",
		source: "cline"
	},
	{
		id: "cline-free/mimo-v2.6-flash",
		name: FLEET_BADGE + "Mimo V2.6 Flash",
		source: "cline"
	},
	{
		id: "cline-free/muse-spark-1.3-contributor",
		name: FLEET_BADGE + "Muse Spark 1.3 Contributor",
		source: "cline"
	},
	{
		id: "apodex/apodex-1.1-mini:free",
		source: "openrouter"
	},
	{
		id: "inclusionai/ling-3.0-flash-sante:free",
		source: "openrouter"
	},
	{
		id: "qwen/qwen3.8-27b:free",
		source: "openrouter"
	},
	{
		id: "dots-studio/dots-3-note-preview:free",
		source: "openrouter"
	},
	{
		id: "liquid/lfm-2.5-2.6b:free",
		source: "openrouter"
	},
	{
		id: "nvidia/nemotron-3.5-lightning:free",
		source: "openrouter"
	},
	{
		id: "thinkingmachines/inkling-small:free",
		source: "openrouter"
	},
	{
		id: "poolside/laguna-s-2.1:free",
		source: "openrouter"
	},
	{
		id: "thinkingmachines/inkling:free",
		source: "openrouter"
	},
	{
		id: "poolside/laguna-xs-2.1:free",
		source: "openrouter"
	},
	{
		id: "cohere/north-mini-code:free",
		source: "openrouter"
	},
	{
		id: "nvidia/nemotron-3.5-content-safety:free",
		source: "openrouter"
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b:free",
		source: "openrouter"
	},
	{
		id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		source: "openrouter"
	},
	{
		id: "google/gemma-4-26b-a4b-it:free",
		source: "openrouter"
	},
	{
		id: "google/gemma-4-31b-it:free",
		source: "openrouter"
	},
	{
		id: "nvidia/nemotron-3-super-120b-a12b:free",
		source: "openrouter"
	}
];
function isFreeModel(id) {
	return id.endsWith(":free");
}
/** "cline-pass/glm-5.3" -> "Glm 5.3"; bucket names are often raw ids. */
function prettifyBucketName(raw, id) {
	if (typeof raw === "string" && raw.length > 0 && !raw.includes("/") && !/^[a-z0-9.-]+$/.test(raw)) return raw;
	return ((raw ?? id).split("/").at(-1) ?? id).replace(/[:].*$/, "").split("-").filter((part) => part.length > 0).map((part) => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function defaultCachePath(dataDir) {
	return join(dataDir, "cache", "catalog.json");
}
function defaultDataDir() {
	return join(homedir(), ".cline2dsh");
}
var ModelCatalog = class {
	#baseURL;
	#credentialsPath;
	#cachePath;
	#refreshSeconds;
	#freeOnly;
	#includeClinePass;
	#fetchImpl;
	#onRefresh;
	#entries = /* @__PURE__ */ new Map();
	#ordered = [];
	#status = "pending";
	#fetchedAt;
	#counts = {
		freeBucket: 0,
		clinePass: 0,
		openrouterFree: 0
	};
	#timer;
	#refreshing;
	constructor(options) {
		this.#baseURL = options.baseURL.replace(/\/+$/, "");
		this.#credentialsPath = options.credentialsPath;
		this.#cachePath = options.cachePath;
		this.#refreshSeconds = options.refreshSeconds;
		this.#freeOnly = options.freeOnly;
		this.#includeClinePass = options.includeClinePass === true;
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#onRefresh = options.onRefresh;
	}
	list() {
		if (this.#entries.size > 0) return [...this.#ordered];
		return STATIC_FREE_MODELS.map((entry) => entry.id);
	}
	/** Picker order: Cline's own free fleet first, then by display name. */
	#compare(a, b) {
		const rank = (entry) => entry.source === "cline" ? 0 : 1;
		const byRank = rank(a) - rank(b);
		if (byRank !== 0) return byRank;
		const an = (this.display(a.id) ?? a.id).toLowerCase();
		const bn = (this.display(b.id) ?? b.id).toLowerCase();
		if (an !== bn) return an < bn ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	}
	display(model) {
		return this.#entries.get(model)?.name ?? model;
	}
	snapshot() {
		return {
			status: this.#status,
			total: this.#entries.size,
			exposed: this.#entries.size,
			...this.#counts,
			...this.#fetchedAt ? { fetchedAt: this.#fetchedAt } : {}
		};
	}
	limits(model) {
		const entry = this.#entries.get(model);
		if (!entry) return void 0;
		return {
			contextWindow: entry.contextWindow,
			maxOutput: entry.maxOutput
		};
	}
	modalities(model) {
		return this.#entries.get(model)?.input;
	}
	/** Initial cache read (tier 2); never throws. Returns a startup note or ''. */
	async prime() {
		try {
			const raw = await readFile(this.#cachePath, "utf8");
			const parsed = JSON.parse(raw);
			const age = Date.now() - new Date(parsed.fetchedAt).getTime();
			if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS && Array.isArray(parsed.entries)) {
				this.#ingest(parsed.entries, "cache", parsed.fetchedAt);
				return `cache (${parsed.entries.length} models, age ${Math.round(age / 6e4)}m)`;
			}
			return "cache expired";
		} catch {
			return "no cache";
		}
	}
	async start() {
		await this.prime();
		await this.refresh();
		this.#timer = setInterval(() => {
			this.refresh().catch(() => {});
		}, this.#refreshSeconds * 1e3);
		this.#timer.unref?.();
	}
	stop() {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = void 0;
		}
	}
	async refresh() {
		if (this.#refreshing) return this.#refreshing;
		this.#refreshing = this.#refreshOnce().finally(() => {
			this.#refreshing = void 0;
		});
		return this.#refreshing;
	}
	async #refreshOnce() {
		try {
			const [buckets, orFree] = await Promise.all([this.#fetchFreeBuckets(), this.#fetchOpenRouterFree()]);
			const entries = /* @__PURE__ */ new Map();
			for (const entry of buckets.entries()) entries.set(entry[0], entry[1]);
			for (const entry of orFree) if (!entries.has(entry.id)) entries.set(entry.id, entry);
			if (entries.size === 0) throw new Error("both free sources came back empty");
			this.#ingest([...entries.values()], "live", (/* @__PURE__ */ new Date()).toISOString());
			await this.#writeCache([...entries.values()]).catch(() => {});
			this.#announce("");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (this.#entries.size === 0) this.#ingest(STATIC_FREE_MODELS, "static");
			this.#announce(message);
		}
	}
	/** Cline's own free fleet (the `free` bucket; `clinePass` is opt-in). */
	async #fetchFreeBuckets() {
		const { accessToken, accountId } = await getValidAccessToken({
			baseURL: this.#baseURL,
			credentialsPath: this.#credentialsPath
		});
		const url = `${this.#baseURL}/ai/cline/recommended-models`;
		const response = await this.#fetchImpl(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				...clineRequestHeaders(accountId)
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
		const body = await response.json();
		const entries = /* @__PURE__ */ new Map();
		const take = (rows, tag) => {
			let n = 0;
			for (const row of rows ?? []) {
				if (typeof row?.id !== "string" || row.id.length === 0) continue;
				n += 1;
				if (tag === "clinePass" && !this.#includeClinePass) continue;
				if (entries.has(row.id)) continue;
				entries.set(row.id, {
					id: row.id,
					name: fleetDisplayName(row.name, row.id),
					source: "cline"
				});
			}
			return n;
		};
		this.#counts.freeBucket = take(body.free, "free");
		this.#counts.clinePass = take(body.clinePass, "clinePass");
		return entries;
	}
	/** OpenRouter-routed free models: `:free` suffix rows of GET /models. */
	async #fetchOpenRouterFree() {
		const { accessToken, accountId } = await getValidAccessToken({
			baseURL: this.#baseURL,
			credentialsPath: this.#credentialsPath
		});
		const url = `${this.#baseURL}/models`;
		const response = await this.#fetchImpl(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...clineRequestHeaders(accountId)
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
		const body = await response.json();
		const rows = body.data ?? body.models ?? [];
		const ids = [];
		for (const row of rows) {
			if (typeof row?.id !== "string" || row.id.length === 0) continue;
			if (this.#freeOnly && !isFreeModel(row.id)) continue;
			ids.push(row.id);
		}
		this.#counts.openrouterFree = ids.length;
		if (ids.length === 0) return [];
		const enriched = await this.#enrich(ids).catch(() => void 0);
		return ids.map((id) => ({
			...enriched?.get(id) ?? { id },
			source: "openrouter"
		}));
	}
	/**
	* Best-effort OpenRouter metadata: display name, context window, max
	* output, image input. Cline's OpenRouter ids are verbatim OpenRouter ids,
	* so the join is exact; any failure only costs the enrichment.
	*/
	async #enrich(ids) {
		const wanted = new Set(ids);
		const response = await this.#fetchImpl(OPENROUTER_MODELS_URL, {
			method: "GET",
			signal: AbortSignal.timeout(1e4)
		});
		if (!response.ok) throw new Error(`openrouter metadata -> ${response.status}`);
		const body = await response.json();
		const map = /* @__PURE__ */ new Map();
		for (const row of body.data ?? []) {
			if (typeof row?.id !== "string" || !wanted.has(row.id)) continue;
			const entry = { id: row.id };
			if (typeof row.name === "string" && row.name.length > 0) entry.name = row.name;
			if (typeof row.context_length === "number" && row.context_length > 0) entry.contextWindow = row.context_length;
			if (typeof row.top_provider?.max_completion_tokens === "number" && row.top_provider.max_completion_tokens > 0) entry.maxOutput = row.top_provider.max_completion_tokens;
			const inputs = row.architecture?.input_modalities;
			if (Array.isArray(inputs) && inputs.length > 0) entry.input = inputs.includes("image") ? ["text", "image"] : ["text"];
			map.set(row.id, entry);
		}
		return map;
	}
	#ingest(entries, status, fetchedAt) {
		const next = /* @__PURE__ */ new Map();
		for (const entry of entries) if (typeof entry?.id === "string" && entry.id.length > 0) next.set(entry.id, entry);
		if (next.size === 0) return;
		this.#entries = next;
		this.#ordered = [...next.values()].sort((a, b) => this.#compare(a, b)).map((entry) => entry.id);
		this.#status = status;
		this.#fetchedAt = fetchedAt ?? (/* @__PURE__ */ new Date()).toISOString();
	}
	async #writeCache(entries) {
		const file = {
			fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
			entries
		};
		await mkdir(dirname(this.#cachePath), { recursive: true });
		await writeFile(this.#cachePath, JSON.stringify(file), "utf8");
	}
	#announce(lastError) {
		this.#onRefresh?.(this.snapshot(), lastError);
	}
};

//#endregion
//#region src/config.ts
const defaults = {
	providerId: "cline2dsh",
	baseURL: "https://api.cline.bot/api/v1",
	credentialsPath: "",
	refreshSeconds: 300,
	freeOnly: true,
	includeClinePass: false
};
function resolveConfig(config = {}) {
	return {
		...defaults,
		...config
	};
}
/**
* The plugin's `Config` — the DSH settings contract. Everything here is
* ordinary composition configuration (set via cordis.patch.yml), so no
* `.volatile()` node: the settings card stays read-only for these fields.
*/
const Config = Schema.object({
	providerId: Schema.string().default(defaults.providerId),
	baseURL: Schema.string().default(defaults.baseURL),
	credentialsPath: Schema.string().default(defaults.credentialsPath),
	refreshSeconds: Schema.number().step(1).min(30).default(defaults.refreshSeconds),
	freeOnly: Schema.boolean().default(defaults.freeOnly),
	includeClinePass: Schema.boolean().default(defaults.includeClinePass),
	firstEventMs: Schema.number().step(1).min(1e3).max(6e5),
	bodyIdleMs: Schema.number().step(1).min(1e3).max(6e5)
});

//#endregion
//#region src/index.ts
const name = "cline2dsh";
/** Bumped per release; logged at registration so the live code is identifiable. */
const PLUGIN_VERSION = "0.3.2";
/** Only `llm` gates this fiber: the adapter needs nothing else. */
const inject = ["llm"];
function apply(ctx, config = {}) {
	const logger = ctx.logger;
	const cfg = resolveConfig(config);
	const credentialsPath = cfg.credentialsPath.length > 0 ? cfg.credentialsPath : defaultCredentialsPath();
	if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
		logger.error("cline2dsh: llm service unavailable; adapter cannot register");
		return;
	}
	const dataDir = defaultDataDir();
	const catalog = new ModelCatalog({
		baseURL: cfg.baseURL,
		credentialsPath,
		cachePath: defaultCachePath(dataDir),
		refreshSeconds: cfg.refreshSeconds,
		freeOnly: cfg.freeOnly,
		includeClinePass: cfg.includeClinePass,
		onRefresh: (status, lastError) => {
			if (lastError) logger.warn(`cline2dsh: catalog refresh issue (${status.status}): ${lastError}`);
			else logger.info(`cline2dsh: catalog ${status.status} (${status.exposed} free models: free-bucket ${status.freeBucket}, cline-pass ${status.clinePass}, :free ${status.openrouterFree})`);
		}
	});
	const adapter = new ClineAdapter(catalog, {
		baseURL: cfg.baseURL,
		credentialsPath,
		firstEventMs: cfg.firstEventMs,
		bodyIdleMs: cfg.bodyIdleMs
	});
	ctx.llm.registerAdapter([PROVIDER_ID], adapter);
	logger.info(`cline2dsh v${PLUGIN_VERSION}: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`);
	readClineCredentialsCached(credentialsPath).then((creds) => {
		const expires = creds.expiresAt ? `; token expires ${new Date(creds.expiresAt).toISOString()}` : "";
		logger.info(`cline2dsh: Cline credentials found (account ${creds.accountId.slice(0, 12)}…)${expires}`);
	}).catch((err) => {
		logger.warn(`${err.message}`);
	});
	catalog.start().catch((err) => {
		logger.error(`cline2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	const maybeEffect = ctx.effect;
	if (typeof maybeEffect === "function") maybeEffect.call(ctx, () => () => {
		catalog.stop();
	});
}

//#endregion
export { ClineAdapter, Config, ModelCatalog, PLUGIN_VERSION, PROVIDER_ID, apply, defaultCachePath, defaultDataDir, getValidAccessToken, inject, name, readClineCredentials, readClineCredentialsCached, refreshClineToken, resolveConfig };