// README screenshots and a browser smoke test, against a demo instance (DEMO_DATA=true seeds seven songs and four months of practice):
//
//   DATA_DIR=/tmp/guitar-demo DEMO_DATA=true ADMIN_EMAIL=demo@example.com ADMIN_PASSWORD=demodemo1 ADMIN_NAME=Maya PORT=18306 ./pocket-guitar
//   CDP=http://127.0.0.1:19271 BASE=http://127.0.0.1:18306 node scripts/screenshots.mjs   # any Chrome with remote debugging
//   SHOTS=0 … node scripts/screenshots.mjs                                                  # checks only
//   OUT=/tmp/shots … node scripts/screenshots.mjs                                           # somewhere else than docs/screenshots
// playwright-core comes from web/node_modules, or set PW_FROM to a package.json next to an install of it.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(process.env.PW_FROM || new URL('../web/package.json', import.meta.url))
let pw
try { pw = require('playwright') } catch { pw = require('playwright-core') }
const { chromium } = pw
const base = process.env.BASE || 'http://127.0.0.1:18306'
const shots = process.env.SHOTS !== '0'
const dir = process.env.OUT ? process.env.OUT.replace(/\/?$/, '/') : new URL('../docs/screenshots/', import.meta.url).pathname
const browser = process.env.CDP ? await chromium.connectOverCDP(process.env.CDP) : await chromium.launch()
const errors = []

async function session({ phone = false, dark = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: phone ? 3 : 2, isMobile: phone, hasTouch: phone, colorScheme: dark ? 'dark' : 'light',
    userAgent: phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : undefined,
  })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(`pageerror: ${e}`))
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await page.goto(base + '/login')
  const status = await page.evaluate(() => fetch('/api/v1/auth/status').then(r => r.json()))
  if (status.auth_mode === 'local') {
    const res = await page.evaluate(() => fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demodemo1' }) }).then(r => r.status))
    assert.equal(res, 200, 'demo sign-in')
  }
  return { ctx, page }
}
async function go(page, path, wait = 1500, still = true) {
  await page.goto(base + path, { waitUntil: 'networkidle' })
  // headless Chrome freezes CSS fade-ins: show everything at once
  if (still) await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(wait)
}
async function shot(page, name) { if (shots) await page.screenshot({ path: dir + name + '.png' }) }
async function tabId(page, q) {
  const r = await page.evaluate(q => fetch(`/api/v1/tabs?q=${encodeURIComponent(q)}`).then(r => r.json()), q)
  assert.ok(r.tabs.length, `demo song ${q}`)
  return r.tabs[0].id
}
async function player(page, q) {
  const id = await tabId(page, q)
  await go(page, `/tab/${id}`, 4000)
}

// ---- desktop ----
{
  const { ctx, page } = await session()
  await go(page, '/')
  assert.ok(await page.getByText(/in a row/).first().isVisible(), 'home shows the streak')
  await shot(page, 'desktop-home')
  await go(page, '/library')
  assert.ok(await page.getByText('House of the Rising Sun').first().isVisible(), 'library lists demo songs')
  await shot(page, 'desktop-library')
  await player(page, 'rising')
  await shot(page, 'desktop-player')
  await go(page, '/practice', 2000)
  await shot(page, 'desktop-practice')
  await go(page, '/tools/metronome')
  await shot(page, 'desktop-metronome')
  const sl = await page.evaluate(() => fetch('/api/v1/setlists').then(r => r.json()))
  await go(page, `/setlists/${sl[0].id}`)
  await shot(page, 'desktop-setlist')
  await go(page, '/settings/folders')
  await shot(page, 'desktop-settings')
  await ctx.close()
}
// ---- desktop, dark ----
{
  const { ctx, page } = await session({ dark: true })
  await player(page, 'shuffle')
  await shot(page, 'desktop-player-dark')
  await go(page, '/')
  await shot(page, 'desktop-home-dark')
  await ctx.close()
}
// ---- phone ----
{
  const { ctx, page } = await session({ phone: true })
  await go(page, '/')
  await shot(page, 'phone-home')
  await go(page, '/library')
  await shot(page, 'phone-library')
  await player(page, 'pentatonic')
  await shot(page, 'phone-player')
  await go(page, '/tools/tuner')
  await shot(page, 'phone-tuner')
  await go(page, '/practice', 2000)
  await shot(page, 'phone-practice')
  await ctx.close()
}
{
  const { ctx, page } = await session({ phone: true, dark: true })
  await player(page, 'greensleeves')
  await shot(page, 'phone-player-dark')
  await ctx.close()
}

await browser.close()
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('ok', shots ? `screenshots in ${dir}` : '(checks only)')
