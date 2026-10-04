/**
 * Drives the Learn page through the Chrome DevTools Protocol.
 *
 * A screenshot of a static page proves it renders; it does not prove a learner can use it. This script
 * clicks through the actual loop — ask, record, ask again — and captures the page after each step, so the
 * interaction path is verified rather than assumed.
 *
 * Kept in the repository because the same script is the regression check for the interface: run it against
 * a local server and the screenshots either show the loop working or they do not.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const url = process.argv[2] ?? 'http://127.0.0.1:4321/'
const outDir = process.argv[3] ?? join(tmpdir(), 'episteme-ui')
const debugPort = 9333

const browser = EDGE_CANDIDATES.find((candidate) => existsSync(candidate))

if (browser === undefined) {
  console.error('No Chromium browser found.')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const profile = join(tmpdir(), `episteme-cdp-${Date.now()}`)

const child = spawn(
  browser,
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--window-size=1280,1400',
    url,
  ],
  { stdio: 'ignore' },
)

/** Waits for the devtools endpoint to answer. */
async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json())
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('devtools endpoint never came up')
}

const socket = new WebSocket(await target())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})

function send(method, params = {}) {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluates an expression in the page and returns its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(result.exceptionDetails.exception?.description)}`)
  }
  return result.result.value
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })
  const path = join(outDir, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  console.log(`  captured ${name}.png`)
}

const steps = []

async function step(name, expression) {
  const value = await evaluate(expression)
  steps.push({ name, value })
  console.log(`  ${name}: ${JSON.stringify(value)}`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  await shot(name)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await new Promise((resolve) => setTimeout(resolve, 900))

  console.log('driving the interface:')

  await step('01-initial', 'document.querySelector(".intro h3").textContent')

  await step(
    '02-asked',
    `(async () => {
      document.getElementById('q').value = 'why is order hard for attention'
      await ask()
      return {
        badge: document.querySelector('.badge').textContent,
        cards: document.querySelectorAll('.card').length,
        bars: document.querySelectorAll('.bar').length,
        firstReason: document.querySelector('.bar .why').textContent,
      }
    })()`,
  )

  await step(
    '03-structure',
    `(() => {
      const headings = [...document.querySelectorAll('h2')].map((n) => n.textContent)
      return {
        headings,
        signalNames: [...new Set([...document.querySelectorAll('.bar .name')].map((n) => n.textContent))],
        weightsShown: document.querySelectorAll('#legend code').length,
      }
    })()`,
  )

  await step(
    '04-recorded',
    `(async () => {
      // Record on the highest-ranked node through the card's own buttons, which is the path a learner uses.
      // Selected **structurally** — first row, first button — rather than by matching button text. The text
      // is Simplified Chinese now, and matching it broke the driver: it looked for "low" among buttons
      // labelled 低, found nothing, and threw on the click. A driver that asserts on display strings is
      // testing the translation rather than the interaction.
      const top = state.last.ranked[0].nodeId
      state.selected = top
      renderRecord()

      // Pick a button that is *not* already the recorded value, so the step always changes something.
      // Without this the driver only passed on a fresh graph: a second run recorded the same value,
      // nothing changed, no comparison appeared, and step 06 reported zero rows — which looks like a
      // broken interface and is actually a no-op record.
      const firstRow = document.querySelector('.card .quick .quickrow')
      const buttons = firstRow ? [...firstRow.querySelectorAll('button')] : []
      const unset = buttons.find((b) => !b.classList.contains('on'))
      const button = unset ?? buttons[0]
      if (!button) throw new Error('no quick-record button on the first card')
      const alreadySet = unset === undefined
      button.click()
      await new Promise((r) => setTimeout(r, 1400))
      return {
        recorded: top,
        clicked: button.textContent,
        changeBoxShown: document.querySelector('.change') !== null,
        tags: [...document.querySelectorAll('.change .tagline')].map((n) => n.textContent),
        // True when every level of the first dimension was already recorded, so the click was a no-op.
        wasAlreadyAtThisValue: alreadySet,
      }
    })()`,
  )

  await step(
    '05-teal-marked',
    `(() => {
      const marked = [...document.querySelectorAll('.card.mine')].map((c) => c.querySelector('.id').textContent)
      return {
        cardsMarkedAsYours: marked,
        graphRowsWithState: document.querySelectorAll('.node .st:not(.none)').length,
        badge: document.querySelector('.badge').textContent,
      }
    })()`,
  )

  await step(
    '06-answer-changed',
    `(() => {
      const rows = document.querySelectorAll('.change p')
      return {
        rows: rows.length,
        before: rows[0] ? rows[0].textContent.slice(0, 80) : null,
        after: rows[1] ? rows[1].textContent.slice(0, 80) : null,
        differ: rows[0] && rows[1] ? rows[0].textContent !== rows[1].textContent : null,
      }
    })()`,
  )

  await step(
    '07-new-question',
    `(async () => {
      document.getElementById('q').value = 'what does positional encoding actually do'
      await ask()
      return {
        comparisonCleared: document.querySelector('.change') === null,
        top: state.last.ranked[0].label,
      }
    })()`,
  )

  console.log('\nsummary:')
  console.log(JSON.stringify(steps, null, 2))
  console.log(`\nscreenshots in ${outDir}`)
} finally {
  socket.close()
  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 400))
  rmSync(profile, { recursive: true, force: true })
}
