import { EmbeddingError } from '@episteme/core'
import {
  HttpEmbeddingAdapter,
  extractVectors,
  ollamaEmbeddingAdapter,
  openAiEmbeddingAdapter,
  textEmbeddingsInferenceAdapter,
} from '@episteme/embeddings-http'
import { describe, expect, it } from 'vitest'

/**
 * The HTTP embedding contract.
 *
 * Tested against a stub `fetch` rather than a live server, for two reasons: the suite must not depend on
 * a model runtime being installed or started, and the request/response shape is what this package
 * actually promises. What a *specific* provider does behind that shape is that provider's business.
 *
 * A real local provider was not verifiable in this environment — the available Ollama build has no
 * embedding support (its server rejects `/api/embed` with "start it with --embeddings", and `serve` has
 * no such flag), and its five installed models are all chat models. That is recorded as a known gap
 * rather than papered over: the seam is implemented and tested, the end-to-end run is not.
 */

interface Call {
  readonly url: string
  readonly body: unknown
  readonly headers: Record<string, string>
}

/** A stub fetch that records what it was asked and replies with a canned response. */
function stubFetch(reply: { status?: number; json?: unknown; text?: string; throws?: Error }): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    // `init.body` is typed `BodyInit | null | undefined`, so narrowing it before parsing keeps the
    // recorder honest rather than stringifying whatever it happens to hold.
    const rawBody = typeof init.body === 'string' ? init.body : '{}'
    calls.push({
      url,
      body: JSON.parse(rawBody) as unknown,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    if (reply.throws !== undefined) return Promise.reject(reply.throws)
    const status = reply.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.json),
      text: () => Promise.resolve(reply.text ?? ''),
    } as unknown as Response)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('http embedding adapter', () => {
  it('speaks the Ollama shape and learns the vector width', async () => {
    const { fetchImpl, calls } = stubFetch({ json: { embeddings: [[1, 2, 3]] } })
    const adapter = ollamaEmbeddingAdapter({
      baseUrl: 'http://127.0.0.1:11434/',
      model: 'nomic-embed-text',
      fetchImpl,
    })

    expect(adapter.dimensions).toBe(0)
    const vector = await adapter.embed('hello')

    expect(vector).toEqual([1, 2, 3])
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/embed')
    expect(calls[0]?.body).toEqual({ model: 'nomic-embed-text', input: 'hello' })
    // Width is learned rather than required up front.
    expect(adapter.dimensions).toBe(3)
    // And the model name is the adapter's identity, because the cache keys on it.
    expect(adapter.model).toBe('nomic-embed-text')
  })

  it('speaks the OpenAI-compatible shape, including a batch', async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] },
    })
    const adapter = openAiEmbeddingAdapter({
      baseUrl: 'http://127.0.0.1:8080',
      model: 'text-embedding-3-small',
      apiKey: 'secret-token',
      fetchImpl,
    })

    const vectors = await adapter.embedMany(['a', 'b'])

    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/v1/embeddings')
    expect(calls[0]?.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] })
    expect(calls[0]?.headers['authorization']).toBe('Bearer secret-token')
  })

  it('speaks the text-embeddings-inference shape', async () => {
    const { fetchImpl, calls } = stubFetch({ json: [[1, 2]] })
    const adapter = textEmbeddingsInferenceAdapter({
      baseUrl: 'http://127.0.0.1:8081',
      model: 'bge-small',
      fetchImpl,
    })

    await adapter.embedMany(['a'])

    expect(calls[0]?.url).toBe('http://127.0.0.1:8081/embed')
    expect(calls[0]?.body).toEqual({ inputs: ['a'] })
    // No key configured, so no authorization header is invented.
    expect(calls[0]?.headers['authorization']).toBeUndefined()
  })

  it('sends a single text as a string, which providers commonly require', async () => {
    const { fetchImpl, calls } = stubFetch({ json: { embeddings: [[1]] } })
    const adapter = ollamaEmbeddingAdapter({ baseUrl: 'http://x', model: 'm', fetchImpl })

    await adapter.embed('only one')

    expect(calls[0]?.body).toEqual({ model: 'm', input: 'only one' })
  })

  it('reports an unreachable provider as unavailable rather than as an empty result', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' })
    const { fetchImpl } = stubFetch({ throws: refused })
    const adapter = ollamaEmbeddingAdapter({ baseUrl: 'http://127.0.0.1:9', model: 'm', fetchImpl })

    // A typed failure, because a caller's response differs: "the provider is down" is not "the learner
    // understands nothing".
    const error = await adapter.embed('x').catch((caught: unknown) => caught)
    expect(EmbeddingError.is(error)).toBe(true)
    if (!EmbeddingError.is(error)) return
    expect(error.kind).toBe('unavailable')
    expect(error.model).toBe('m')
    expect(error.message).toContain('unreachable')
  })

  it('distinguishes a timeout from an unreachable server', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { fetchImpl } = stubFetch({ throws: timeout })
    const adapter = ollamaEmbeddingAdapter({ baseUrl: 'http://x', model: 'm', fetchImpl })

    const error = await adapter.embed('x').catch((caught: unknown) => caught)
    expect(EmbeddingError.is(error)).toBe(true)
    if (!EmbeddingError.is(error)) return
    expect(error.kind).toBe('timeout')
  })

  it('surfaces a provider error status with its detail', async () => {
    const { fetchImpl } = stubFetch({
      status: 501,
      text: 'this server does not support embeddings',
    })
    const adapter = ollamaEmbeddingAdapter({ baseUrl: 'http://x', model: 'm', fetchImpl })

    const error = await adapter.embed('x').catch((caught: unknown) => caught)
    expect(EmbeddingError.is(error)).toBe(true)
    if (!EmbeddingError.is(error)) return
    expect(error.kind).toBe('provider_error')
    expect(error.message).toContain('501')
    expect(error.message).toContain('does not support embeddings')
  })

  it('refuses a malformed body instead of treating it as no similarity', async () => {
    // A `200` carrying an error object is the dangerous case: a zero-length vector makes every
    // similarity `0`, which looks exactly like "nothing is relevant".
    const wrong = stubFetch({ json: { error: 'model not found' } })
    const adapter = ollamaEmbeddingAdapter({
      baseUrl: 'http://x',
      model: 'm',
      fetchImpl: wrong.fetchImpl,
    })
    const error = await adapter.embed('x').catch((caught: unknown) => caught)
    expect(EmbeddingError.is(error)).toBe(true)
    if (EmbeddingError.is(error)) expect(error.kind).toBe('malformed_response')

    expect(() => extractVectors({ embeddings: [[1, 'two']] }, 'ollama')).toThrow(EmbeddingError)
    expect(() => extractVectors({ embeddings: ['nope'] }, 'ollama')).toThrow(
      /not an array of numbers/,
    )
  })

  it('refuses a response whose count does not match the request', async () => {
    const { fetchImpl } = stubFetch({ json: { embeddings: [[1]] } })
    const adapter = ollamaEmbeddingAdapter({ baseUrl: 'http://x', model: 'm', fetchImpl })

    await expect(adapter.embedMany(['a', 'b'])).rejects.toThrow(/received 1/)
  })

  it('refuses a width change, which would make similarity meaningless', async () => {
    const { fetchImpl } = stubFetch({ json: { embeddings: [[1, 2, 3]] } })
    const adapter = new HttpEmbeddingAdapter({
      baseUrl: 'http://x',
      model: 'm',
      dimensions: 2,
      fetchImpl,
    })

    await expect(adapter.embed('x')).rejects.toThrow(/expected 2-dimensional/)
  })

  it('returns nothing for an empty batch without calling the provider', async () => {
    const { fetchImpl, calls } = stubFetch({ json: { embeddings: [] } })
    const adapter = ollamaEmbeddingAdapter({ baseUrl: 'http://x', model: 'm', fetchImpl })

    expect(await adapter.embedMany([])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
