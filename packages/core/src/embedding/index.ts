import type { EpochMillis } from '../ontology/primitives.js'

/**
 * Provider-neutral text embedding.
 *
 * Two methods, one required. `embedMany` is optional because a provider may have a batch endpoint
 * worth using, and pretending every provider does would either force a fake implementation or
 * exclude the ones that do not.
 *
 * Nothing here knows about a specific vendor, and no vector database is involved: at the scale of one
 * person's cognitive graph, similarity is a linear scan.
 */
export interface EmbeddingAdapter {
  /** Identifies the model whose vectors these are. */
  readonly model: string
  /** The vector width, or `undefined` until the provider has reported it. */
  readonly dimensions?: number
  embed(text: string): Promise<Vector>
  embedMany?(texts: readonly string[]): Promise<readonly Vector[]>
}

/** A dense vector. Named so the intent is visible at call sites. */
export type Vector = readonly number[]

/**
 * Why an embedding operation failed.
 *
 * Typed rather than a bare `Error` because the caller's response differs by cause: an unavailable
 * provider means retrieval cannot answer at all, while a text the provider refused is a single
 * unreachable item. Only the first should stop a retrieval.
 */
export type EmbeddingFailureKind =
  /** The provider could not be reached, or is not configured. */
  | 'unavailable'
  /** The provider answered, with an error. */
  | 'provider_error'
  /** The provider returned something that is not a usable vector. */
  | 'malformed_response'
  /** The provider took too long. */
  | 'timeout'

export class EmbeddingError extends Error {
  readonly kind: EmbeddingFailureKind
  /** The model in use, when known, so a failure names what was being asked. */
  readonly model?: string
  override readonly cause?: unknown

  constructor(
    kind: EmbeddingFailureKind,
    message: string,
    options: { readonly model?: string; readonly cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'EmbeddingError'
    this.kind = kind
    if (options.model !== undefined) this.model = options.model
    if (options.cause !== undefined) this.cause = options.cause
  }

  static is(error: unknown): error is EmbeddingError {
    return error instanceof EmbeddingError
  }
}

/** A vector together with the identity of the text it represents. */
export interface CachedEmbedding {
  readonly key: string
  readonly vector: Vector
  /** Which model produced it. A vector from another model is not comparable and must not be reused. */
  readonly model: string
  readonly computedAt: EpochMillis
}

/**
 * A store for computed embeddings.
 *
 * **Embeddings are derived data.** They can be deleted and recomputed with no loss of user cognition,
 * and this interface exists to keep that distinction explicit: the event history and the graph are the
 * source of truth, and nothing here may ever be treated as one.
 *
 * The cache is allowed to be wrong in the harmless direction — a miss costs a recomputation — so an
 * implementation never has to be transactional.
 */
export interface EmbeddingCache {
  /** A cached vector, or `undefined` on a miss or a model mismatch. */
  get(key: string, model: string): Vector | undefined
  set(key: string, model: string, vector: Vector): void
  /** How many entries are held, for a demo or a diagnostic to report. */
  readonly size: number
  /** Discards everything, which is always safe. */
  clear(): void
}

/**
 * A stable cache key for a piece of text.
 *
 * Text is the key because that is what is embedded. Whitespace is collapsed first, so the same
 * sentence typed with different spacing reuses one vector rather than paying for a second.
 */
export function embeddingKeyFor(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase()
}
