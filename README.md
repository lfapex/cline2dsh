# cline2dsh

Cline free models for DeepSeek Harness (DSH). A native DSH `LlmAdapter`
plugin: streams from Cline's OpenAI-compatible backend
(`api.cline.bot/api/v1`) with the locally logged-in Cline desktop account's
token, **free models only** (`:free` ids).

Architecture follows [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
(native adapter mode); the wire layer is the same pi-ai openai-completions
implementation DSH already ships.

## How it works

1. **Credentials**: every request re-reads the Cline desktop app's local
   credential file (`~/.cline/data/settings/providers.json`, mtime-cached)
   for `accessToken` (Bearer) and `accountId` (`clineUserId` header). The
   plugin **never refreshes tokens itself** — WorkOS refresh tokens rotate,
   so a self-refreshing plugin would kick the desktop app out of its
   session; the app renews while it runs.
2. **Model catalog** (three tiers): live `GET /models` (filtered to `:free`)
   → 7-day disk cache (`~/.cline2dsh/cache/catalog.json`) → compiled-in
   static roster (17 verified free models). Best-effort OpenRouter metadata
   enrichment (context window, image input) never blocks the list.
3. **Stream watchdogs**: first-event 30s / body-idle 120s windows keep a
   silently hung upstream from stalling a turn forever.
4. **Attribution headers**: `clineUserId` + `HTTP-Referer: https://cline.bot`
   + `X-Title: Cline`, matching the Cline desktop client.

## Install

Requires DSH ≥ 0.1.7, Node.js ≥ 20, and a logged-in Cline desktop app.

```sh
# from npm (once published)
dsh plugin --profile web add cline2dsh

# or from source
git clone https://github.com/lfapex/cline2dsh.git
cd cline2dsh && npm install && npm run build
dsh plugin --profile web add file:$PWD
```

Desktop profile: use `--profile desktop`. Restart the profile after
installing; a `cline2dsh` provider appears in the model picker.

## Configuration (cordis.patch.yml)

```yaml
- insert:
    - id: cline2dsh
      name: 'cline2dsh'
      config:
        freeOnly: true          # only :free models (default true)
        refreshSeconds: 300     # catalog refresh interval
        baseURL: https://api.cline.bot/api/v1
        credentialsPath: ''     # empty = ~/.cline/data/settings/providers.json
```

## Troubleshooting

- Health snapshot: `~/.cline2dsh/cache/catalog.json` (catalog cache).
- Log says `CLINE_NOT_LOGGED_IN` / `CLINE_NOT_INSTALLED` → open the Cline
  desktop app and sign in once.
- 401 on requests → access token expired; open Cline desktop to refresh,
  then keep going.
- 429 → Cline free-tier rate limit (quota is shared with the desktop app).

## Known limitations

- Consumes your Cline account's free quota, shared with the desktop app.
- After token expiry the Cline desktop app must be opened once (the plugin
  deliberately does not self-refresh; see "How it works").
- Breaks if Cline adds request signing or device attestation.

## License

MIT
