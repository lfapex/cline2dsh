// Live e2e smoke test: credentials -> catalog (free bucket ∪ :free) -> one
// tiny cline-free completion. Run: node test/e2e.mjs
import { ClineAdapter, ModelCatalog, defaultCachePath, defaultDataDir } from '../lib/index.js'
import { readClineCredentialsCached } from '../lib/index.js'

const baseURL = 'https://api.cline.bot/api/v1'
const credentialsPath = process.env.CLINE_CREDS || ''

const creds = await readClineCredentialsCached(credentialsPath || undefined)
console.log('credentials: ok, account =', creds.accountId.slice(0, 12) + '…')

const catalog = new ModelCatalog({
  baseURL,
  credentialsPath,
  cachePath: defaultCachePath(defaultDataDir()),
  refreshSeconds: 300,
  freeOnly: true,
  includeClinePass: false,
})
await catalog.refresh()
const snap = catalog.snapshot()
console.log('catalog:', JSON.stringify(snap))
console.log('models:', catalog.list().join(', '))

const adapter = new ClineAdapter(catalog, { baseURL, credentialsPath })
const wanted = process.env.E2E_MODEL ?? 'cline-free/mimo-v2.6-flash'
const model = catalog.list().includes(wanted) ? wanted : catalog.list()[0]
console.log('testing model:', model)

let text = ''
let finish = null
let usage = null
const t0 = Date.now()
for await (const chunk of adapter.stream({
  provider: 'cline2dsh',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
  maxTokens: 2000,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finish = chunk.reason
  if (chunk.type === 'usage') usage = chunk.usage
}
console.log('stream done in', Date.now() - t0, 'ms')
console.log('text:', JSON.stringify(text.slice(0, 120)))
console.log('usage:', JSON.stringify(usage))
console.log('finish:', JSON.stringify(finish))
if (finish?.kind === 'stop' && text.length > 0) {
  console.log('E2E: PASS')
} else {
  console.log('E2E: FAIL')
  process.exit(1)
}
