import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLearnServer, type LearnServer } from '@episteme/app-learn/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The HTTP surface.
 *
 * Tested over a real socket rather than by calling handlers directly, because everything this layer owns is
 * about the wire: routing, status codes, and the shape the page reads. A test that called `handle` would
 * not exercise the parts most likely to be wrong.
 */

let directory: string
let filePath: string
let server: LearnServer

interface Json {
  readonly [key: string]: unknown
}

async function get(path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${server.url}${path}`)
  const body = (await response.json().catch(() => ({}))) as Json
  return { status: response.status, body }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as Json
  return { status: response.status, body: payload }
}

/**
 * Reads a field the test has asserted is present.
 *
 * Failing loudly beats returning `undefined`: an assertion that silently accepted a missing field would
 * defeat the purpose of testing the wire shape at all.
 */
function field<T>(body: Json, key: string): T {
  const value = body[key]
  if (value === undefined) throw new Error(`response had no "${key}"`)
  return value as T
}

function list<T>(body: Json, key: string): readonly T[] {
  const value = field<unknown>(body, key)
  if (!Array.isArray(value)) throw new Error(`"${key}" was not an array`)
  return value as readonly T[]
}

/** The node id from a `/api/claim` response. */
function claimId(body: Json): string {
  const node = body['node']
  // The body is included in the failure, because "no nodeId" on its own says nothing about whether the
  // route was missing, the payload was wrong, or the request never reached the handler.
  if (typeof node !== 'object' || node === null) {
    throw new Error(`response had no node object: ${JSON.stringify(body)}`)
  }
  const id = (node as { nodeId?: unknown }).nodeId
  if (typeof id !== 'string') throw new Error(`node had no nodeId: ${JSON.stringify(node)}`)
  return id
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-http-'))
  filePath = join(directory, 'learn.jsonl')
  server = await startLearnServer({ port: 0, filePath })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

describe('serving the interface', () => {
  it('serves the page at the root', async () => {
    const response = await fetch(`${server.url}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain('Episteme')
    // The page must not be cached: a reload after recording has to show the new state.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('binds to a loopback address only', () => {
    // There is no authentication on this surface by design, so exposing it on a network interface would be
    // a security decision nobody has made. The default host is asserted rather than assumed.
    expect(server.url).toContain('127.0.0.1')
  })
})

describe('the state endpoint', () => {
  it('returns the seeded topic, the recordable dimensions and the graph', async () => {
    const { status, body } = await get('/api/state')
    expect(status).toBe(200)

    expect(field<{ title: string }>(body, 'topic').title).toBe('How transformers handle order')
    expect(list(body, 'nodes').length).toBeGreaterThan(0)
    expect(list<{ id: string }>(body, 'dimensions').map((dimension) => dimension.id)).toContain(
      'confidence',
    )
    expect(list<{ signal: string }>(body, 'rules').map((rule) => rule.signal)).toContain('semantic')
    expect(field<string>(body, 'retriever')).toBe('hybrid')
  })

  it('attaches each node\u2019s recorded understanding, so the page needs one request', async () => {
    const first = await get('/api/state')
    const aNode = list<{ nodeId: string }>(first.body, 'nodes')[0]?.nodeId
    expect(aNode).toBeDefined()
    if (aNode === undefined) return

    await post('/api/record', { target: aNode, dimensions: { confidence: 'high' } })

    const second = await get('/api/state')
    // Keyed by node, which is what stops the record panel rendering a node as blank when it is not.
    const understanding = field<Record<string, unknown>>(second.body, 'understanding')
    expect(understanding[aNode]).toEqual([{ id: 'confidence', level: 'high' }])
  })
})

describe('the ask endpoint', () => {
  it('answers with the ranking and the reasons behind it', async () => {
    const { status, body } = await post('/api/ask', { question: 'why is order hard for attention' })
    expect(status).toBe(200)

    expect(field<string>(body, 'answer').length).toBeGreaterThan(0)
    expect(field<boolean>(body, 'usedContext')).toBe(false)

    // Every reason carries the arithmetic, so the page can show why a node sits where it does rather than
    // asking the learner to trust a number.
    const ranked = list<{
      reasons: readonly { contribution: number; weight: number; explanation: string }[]
    }>(body, 'ranked')
    expect(ranked.length).toBeGreaterThan(0)
    for (const entry of ranked) {
      for (const reason of entry.reasons) {
        expect(typeof reason.contribution).toBe('number')
        expect(typeof reason.weight).toBe('number')
        expect(reason.explanation.length).toBeGreaterThan(0)
      }
    }
  })

  it('rejects a request with no question, rather than answering nothing', async () => {
    const { status, body } = await post('/api/ask', {})
    expect(status).toBe(500)
    expect(field<string>(body, 'error')).toContain('question')
  })

  it('rejects a non-object body', async () => {
    const response = await fetch(`${server.url}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    })
    expect(response.status).toBe(500)
  })
})

describe('recording through the surface', () => {
  it('records understanding, then the next answer uses it', async () => {
    const created = await post('/api/claim', {
      label: 'attention cannot tell which word came first',
    })
    expect(created.status).toBe(200)
    const target = claimId(created.body)
    const question = 'can attention tell which word came first'

    const before = await post('/api/ask', { question })
    expect(field<boolean>(before.body, 'usedContext')).toBe(false)

    const recorded = await post('/api/record', {
      target,
      dimensions: { confidence: 'low', conflict: 'open' },
    })
    expect(recorded.status).toBe(200)
    expect(list(recorded.body, 'understanding').length).toBe(2)

    const after = await post('/api/ask', { question })
    expect(field<boolean>(after.body, 'usedContext')).toBe(true)
    expect(field<string>(after.body, 'summary')).toContain('conflict=open')
    expect(field<string>(after.body, 'answer')).not.toBe(field<string>(before.body, 'answer'))
  })

  it('refuses a dimension the surface does not expose', async () => {
    const created = await post('/api/claim', { label: 'a claim' })
    const target = claimId(created.body)

    const { status, body } = await post('/api/record', {
      target,
      dimensions: { mastery: 'high' },
    })
    expect(status).toBe(500)
    expect(field<string>(body, 'error')).toContain('not recordable')
  })

  it('refuses state for a node that does not exist', async () => {
    const { status } = await post('/api/record', {
      target: 'no_such_node',
      dimensions: { confidence: 'high' },
    })
    expect(status).toBe(500)
  })
})

describe('routing', () => {
  it('reports an unknown route instead of pretending', async () => {
    const { status, body } = await get('/api/nonsense')
    expect(status).toBe(404)
    expect(field<string>(body, 'error')).toContain('no route')
  })

  it('serves one shared session across requests', async () => {
    const created = await post('/api/claim', { label: 'a shared claim' })
    const target = claimId(created.body)

    // A second request sees the first one's write, which is what makes the page work without reloading.
    const { body } = await get('/api/state')
    expect(list<{ nodeId: string }>(body, 'nodes').map((node) => node.nodeId)).toContain(target)
  })
})
