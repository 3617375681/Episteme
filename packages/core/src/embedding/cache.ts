import type { EmbeddingCache, Vector } from './index.js'

/**
 * An in-memory embedding cache.
 *
 * The default, and usually the right one: embeddings are derived data, so losing them on exit costs a
 * recomputation and nothing else. There is no vector database here because at the scale of one person's
 * cognitive graph a similarity search is a linear scan over a few hundred vectors.
 *
 * Entries are keyed by model as well as text. Two models produce incomparable vectors, and reusing one
 * model's vector for another would silently make similarity meaningless — the worst kind of retrieval
 * bug, because it returns plausible results.
 */
export class InMemoryEmbeddingCache implements EmbeddingCache {
  readonly #byModel = new Map<string, Map<string, Vector>>()

  get size(): number {
    let total = 0
    for (const entries of this.#byModel.values()) total += entries.size
    return total
  }

  get(key: string, model: string): Vector | undefined {
    return this.#byModel.get(model)?.get(key)
  }

  set(key: string, model: string, vector: Vector): void {
    const entries = this.#byModel.get(model)
    if (entries === undefined) {
      this.#byModel.set(model, new Map([[key, vector]]))
      return
    }
    entries.set(key, vector)
  }

  clear(): void {
    this.#byModel.clear()
  }

  /** How many vectors are held for one model, so a demo can show the cache filling up. */
  sizeFor(model: string): number {
    return this.#byModel.get(model)?.size ?? 0
  }
}

export function createInMemoryEmbeddingCache(): EmbeddingCache {
  return new InMemoryEmbeddingCache()
}
