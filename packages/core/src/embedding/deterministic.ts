import type { EmbeddingAdapter, Vector } from './index.js'

/**
 * A deterministic embedding adapter for tests and offline demos.
 *
 * **This is not a language model and does not pretend to be one.** It is a hashed bag of tokens with a
 * small, hand-written lexicon that folds related terms onto a shared token — so
 * `"sequence order"` and `"which token came first"` land near each other because the lexicon says
 * they should, not because anything was learned.
 *
 * It exists for three reasons:
 *
 * 1. **Semantic retrieval has to be testable without a provider.** A suite that needs a model server
 *    running is a suite that fails for reasons unrelated to the code under test.
 * 2. **The pipeline is the thing being proven.** What Phase 2 must demonstrate is that a paraphrased
 *    question reaches stored cognition through the embedding path, that the actor's own state is joined
 *    to it, and that the answer changes. A real model would make that claim *harder* to verify, not
 *    easier: it might have matched anyway.
 * 3. **Word-level correspondences are what a real model gives you for free.** Writing them down here
 *    makes the fake's limits explicit instead of mysterious, which is why the lexicon is small,
 *    readable and finite rather than a clever trick.
 *
 * `EXPANDED_TERMS` is the whole of its "knowledge". Anything not in it is compared by the tokens it
 * literally shares, which is why this adapter is not a substitute for a real provider in production —
 * see `docs/architecture/retrieval.md`.
 */
export const EXPANDED_TERMS: Readonly<Record<string, readonly string[]>> = {
  // Order and position: the words a learner uses for one idea.
  order: ['order', 'sequence', 'position', 'index'],
  sequence: ['order', 'sequence', 'position', 'index'],
  position: ['order', 'sequence', 'position', 'index'],
  positional: ['order', 'sequence', 'position', 'index'],
  index: ['order', 'sequence', 'position', 'index'],
  first: ['order', 'sequence', 'position', 'index'],
  last: ['order', 'sequence', 'position', 'index'],
  arrange: ['order', 'sequence', 'position', 'index'],
  arrangement: ['order', 'sequence', 'position', 'index'],
  orderless: ['order', 'permutation', 'invariance'],

  // Permutation and invariance.
  permutation: ['permutation', 'invariance', 'shuffle'],
  invariance: ['permutation', 'invariance'],
  equivariant: ['permutation', 'invariance'],
  equivariance: ['permutation', 'invariance'],
  shuffle: ['permutation', 'invariance', 'shuffle'],

  // Attention and the attention mechanism.
  'self-attention': ['attention', 'self-attention', 'token'],
  attention: ['attention', 'self-attention', 'token'],
  head: ['attention', 'head'],
  heads: ['attention', 'head'],
  attn: ['attention', 'self-attention', 'token'],

  // Encoding, representation, injection.
  encode: ['encode', 'representation', 'inject'],
  encodes: ['encode', 'representation', 'inject'],
  encoded: ['encode', 'representation', 'inject'],
  encoding: ['encode', 'representation', 'inject'],
  inject: ['encode', 'representation', 'inject'],
  injects: ['encode', 'representation', 'inject'],
  add: ['encode', 'representation', 'inject'],

  // Tokens and words.
  token: ['token', 'word', 'input'],
  tokens: ['token', 'word', 'input'],
  word: ['token', 'word', 'input'],
  words: ['token', 'word', 'input'],
  input: ['token', 'word', 'input'],

  // Transformers and their parts.
  transformer: ['transformer', 'model', 'architecture'],
  transformers: ['transformer', 'model', 'architecture'],
  model: ['transformer', 'model', 'architecture'],
  architecture: ['transformer', 'model', 'architecture'],

  // Relative position and its methods.
  rope: ['relative', 'rotation', 'rope'],
  rotary: ['relative', 'rotation', 'rope'],
  rotation: ['relative', 'rotation', 'rope'],
  rotates: ['relative', 'rotation', 'rope'],
  relative: ['relative', 'rope'],
  absolute: ['absolute', 'index'],

  // Necessity and explanation.
  why: ['why', 'reason', 'necessary'],
  reason: ['why', 'reason', 'necessary'],
  necessary: ['why', 'reason', 'necessary'],
  need: ['why', 'reason', 'necessary'],
  needs: ['why', 'reason', 'necessary'],
  requires: ['why', 'reason', 'necessary'],
}

/**
 * Folds a token onto the vocabulary it should be compared in.
 *
 * Both the term and everything it expands to are kept, so a specific word still counts for itself —
 * `"RoPE"` should not stop being about RoPE because it is also about relative position.
 */
export function expandedTermsOf(token: string): readonly string[] {
  const expansion = EXPANDED_TERMS[token]
  return expansion === undefined ? [token] : [token, ...expansion]
}

export interface DeterministicEmbeddingOptions {
  /**
   * Vector width. Must be a power of two so the hash mask is exact.
   *
   * Wide by default for a reason worth stating, because it was found the hard way: a hashed bag of words
   * collides, and collisions become similarity. At 256 dimensions, `"What is the capital of Portugal?"`
   * scored 0.34 against a claim about token indices — indistinguishable from a true paraphrase at 0.34 —
   * because both happened to share hash buckets. Widening the space is what made the signal mean
   * something; the failure was visible only because an unrelated question was in the evaluation set.
   */
  readonly dimensions?: number
  readonly model?: string
}

/**
 * A stable 32-bit hash.
 *
 * FNV-1a: tiny, dependency-free and well-distributed enough for a hashed bag of words. Stability across
 * runs matters more than cryptographic quality, because a cache written yesterday must still match the
 * vector computed today.
 */
function hashToken(token: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Splits on anything that is not a letter or digit, lowercased. */
export function tokensOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
}

/**
 * A deterministic, provider-free embedding adapter.
 *
 * L2-normalised so cosine similarity is a plain dot product, and unweighted across dimensions: the
 * point is that two texts sharing expanded terms are close, not that any term is rare enough to matter.
 * Term weighting (idf) would be a real improvement and is deliberately absent, because a fake with
 * plausible-looking sophistication invites being trusted.
 */
export class DeterministicEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string
  readonly dimensions: number

  constructor(options: DeterministicEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 8192
    if ((this.dimensions & (this.dimensions - 1)) !== 0) {
      throw new TypeError(`dimensions must be a power of two, got ${this.dimensions}`)
    }
    this.model = options.model ?? `deterministic-v1-${this.dimensions}`
  }

  embed(text: string): Promise<Vector> {
    const vector = new Array<number>(this.dimensions).fill(0)

    for (const token of tokensOf(text)) {
      for (const term of expandedTermsOf(token)) {
        const slot = hashToken(term) & (this.dimensions - 1)
        vector[slot] = (vector[slot] ?? 0) + 1
      }
    }

    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm === 0) return Promise.resolve(vector)

    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] ?? 0) / norm
    }
    return Promise.resolve(vector)
  }

  embedMany(texts: readonly string[]): Promise<readonly Vector[]> {
    return Promise.all(texts.map((text) => this.embed(text)))
  }
}

/** Convenience for a graph-free default, so callers do not each pick a width. */
export function createDeterministicEmbeddingAdapter(
  options: DeterministicEmbeddingOptions = {},
): EmbeddingAdapter {
  return new DeterministicEmbeddingAdapter(options)
}
