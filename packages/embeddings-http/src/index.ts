import { EmbeddingError, isVector, type EmbeddingAdapter, type Vector } from '@episteme/core'

/**
 * An `EmbeddingAdapter` over an HTTP JSON API.
 *
 * **Provider-neutral by configuration.** Three request/response shapes are supported because they cover
 * essentially everything a local or hosted embedding server offers today, and none of them is privileged:
 *
 * | `protocol` | Endpoint | Request | Response |
 * | --- | --- | --- | --- |
 * | `ollama` | `/api/embed` | `{ model, input }` | `{ embeddings: number[][] }` |
 * | `openai` | `/v1/embeddings` | `{ model, input }` | `{ data: [{ embedding }] }` |
 * | `tei` | `/embed` | `{ inputs }` | `number[][]` |
 *
 * Requests are built with `fetch`, which Node has had since 18, so this adds **no dependency** and no
 * native build step. That matters for the same reason JSONL was chosen over SQLite in Phase 1: a learner
 * should not need a toolchain between them and their own cognition.
 *
 * ## What this does not do
 *
 * It does not install, start or manage a model server. Discovering a local runtime is an application's
 * job, not a portable adapter's, and guessing at one would make this class depend on a machine's
 * configuration.
 */
export type EmbeddingProtocol = 'ollama' | 'openai' | 'tei'

export interface HttpEmbeddingOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:11434`. Trailing slashes are tolerated. */
  readonly baseUrl: string
  /** The model to ask for, e.g. `nomic-embed-text`. */
  readonly model: string
  readonly protocol?: EmbeddingProtocol
  /**
   * Bearer token, for a hosted provider.
   *
   * Read from the caller rather than the environment so the adapter has no hidden configuration, and so a
   * secret never appears in a log this class writes. Pass `undefined` for a local server.
   */
  readonly apiKey?: string
  /** Request timeout. A hung embedding call must not hang a retrieval. */
  readonly timeoutMs?: number
  /** Injected for tests, so the contract can be verified without a server. */
  readonly fetchImpl?: typeof fetch
  /** Reported width, when the caller knows it. Otherwise learned from the first response. */
  readonly dimensions?: number
}

interface EmbeddingResponseShape {
  readonly embeddings?: unknown
  readonly data?: unknown
  readonly embedding?: unknown
}

/**
 * An HTTP embedding adapter.
 *
 * The model name is part of the adapter's identity because vectors from different models are not
 * comparable, and the embedding cache keys on it: reusing one model's vector for another would make
 * similarity silently meaningless while still returning plausible results.
 */
export class HttpEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string
  /**
   * The vector width, learned from the first response when the caller did not supply it.
   *
   * Declared as a definite `number` rather than `number | undefined` so the class satisfies the port's
   * optional property: an optional property in an interface permits the *absence* of the property, not a
   * property whose value may be `undefined`. It starts at `0`, which means "not yet known".
   */
  dimensions = 0

  readonly #baseUrl: string
  readonly #protocol: EmbeddingProtocol
  readonly #apiKey: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: HttpEmbeddingOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.model = options.model
    this.#protocol = options.protocol ?? 'ollama'
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#fetch = options.fetchImpl ?? fetch
    this.dimensions = options.dimensions ?? 0
  }

  /** The endpoint and body for the configured protocol. */
  #request(texts: readonly string[]): { url: string; body: unknown } {
    switch (this.#protocol) {
      case 'ollama':
        return {
          url: `${this.#baseUrl}/api/embed`,
          body: { model: this.model, input: texts.length === 1 ? (texts[0] ?? '') : texts },
        }
      case 'openai':
        return {
          url: `${this.#baseUrl}/v1/embeddings`,
          body: { model: this.model, input: texts.length === 1 ? (texts[0] ?? '') : texts },
        }
      case 'tei':
        return { url: `${this.#baseUrl}/embed`, body: { inputs: texts } }
    }
  }

  async embed(text: string): Promise<Vector> {
    const [vector] = await this.#embedAll([text])
    if (vector === undefined) {
      throw new EmbeddingError('malformed_response', 'the provider returned no vector', {
        model: this.model,
      })
    }
    return vector
  }

  embedMany(texts: readonly string[]): Promise<readonly Vector[]> {
    if (texts.length === 0) return Promise.resolve([])
    return this.#embedAll(texts)
  }

  async #embedAll(texts: readonly string[]): Promise<readonly Vector[]> {
    const { url, body } = this.#request(texts)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#apiKey !== undefined) headers['authorization'] = `Bearer ${this.#apiKey}`

    let response: Response
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      // Distinguishing a timeout from a refused connection matters: one is worth retrying and one is a
      // configuration mistake. Both are surfaced rather than swallowed, because a retrieval that quietly
      // found nothing would read as "the learner understands nothing".
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new EmbeddingError(
        timedOut ? 'timeout' : 'unavailable',
        timedOut
          ? `embedding provider at ${url} did not answer within ${this.#timeoutMs}ms`
          : `embedding provider at ${url} is unreachable: ${(error as Error).message}`,
        { model: this.model, cause: error },
      )
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new EmbeddingError(
        'provider_error',
        `embedding provider returned HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
        { model: this.model },
      )
    }

    let payload: EmbeddingResponseShape
    try {
      payload = (await response.json()) as EmbeddingResponseShape
    } catch (error) {
      throw new EmbeddingError('malformed_response', 'embedding provider did not return JSON', {
        model: this.model,
        cause: error,
      })
    }

    const vectors = extractVectors(payload, this.#protocol)
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        'malformed_response',
        `asked for ${texts.length} embedding(s) and received ${vectors.length}`,
        { model: this.model },
      )
    }

    // Width is learned from the first successful response, so a caller need not know it in advance.
    const width = vectors[0]?.length
    if (width !== undefined && this.dimensions !== width) {
      if (this.dimensions !== 0) {
        throw new EmbeddingError(
          'malformed_response',
          `expected ${this.dimensions}-dimensional vectors and received ${width}`,
          { model: this.model },
        )
      }
      this.dimensions = width
    }

    return vectors
  }
}

/**
 * Reads the vectors out of a response, per protocol.
 *
 * Every shape is checked rather than assumed: a provider that answers `200` with an error object would
 * otherwise yield a zero-length vector, and a zero-length vector makes every similarity `0` — which looks
 * exactly like "nothing is relevant".
 */
export function extractVectors(
  payload: EmbeddingResponseShape,
  protocol: EmbeddingProtocol,
): readonly Vector[] {
  const candidates: unknown =
    protocol === 'tei'
      ? payload
      : protocol === 'openai'
        ? readArray(payload.data).map((entry) => readEmbeddingProperty(entry))
        : payload.embeddings

  if (!Array.isArray(candidates)) {
    throw new EmbeddingError(
      'malformed_response',
      `expected an array of embeddings for protocol "${protocol}"`,
    )
  }

  return candidates.map((candidate) => {
    if (!isVector(candidate)) {
      throw new EmbeddingError('malformed_response', 'an embedding was not an array of numbers')
    }
    return candidate
  })
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function readEmbeddingProperty(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return undefined
  return (entry as { embedding?: unknown }).embedding
}

/**
 * Builds an adapter for a local Ollama server.
 *
 * Note in the documentation and here: a local runtime must be started with embedding support and an
 * embedding-capable model. This adapter cannot detect that for you — it reports what the server said.
 */
export function ollamaEmbeddingAdapter(
  options: Omit<HttpEmbeddingOptions, 'protocol'>,
): HttpEmbeddingAdapter {
  return new HttpEmbeddingAdapter({ ...options, protocol: 'ollama' })
}

/** Builds an adapter for an OpenAI-compatible `/v1/embeddings` endpoint. */
export function openAiEmbeddingAdapter(
  options: Omit<HttpEmbeddingOptions, 'protocol'>,
): HttpEmbeddingAdapter {
  return new HttpEmbeddingAdapter({ ...options, protocol: 'openai' })
}

/** Builds an adapter for a Hugging Face text-embeddings-inference server. */
export function textEmbeddingsInferenceAdapter(
  options: Omit<HttpEmbeddingOptions, 'protocol'>,
): HttpEmbeddingAdapter {
  return new HttpEmbeddingAdapter({ ...options, protocol: 'tei' })
}
