import type { Vector } from './index.js'

/**
 * Vector comparison.
 *
 * Kept here rather than in an adapter because it is arithmetic, not provider behaviour: two vectors
 * from the same model must compare the same way whichever adapter produced them.
 */

/**
 * Cosine similarity, in `[-1, 1]`.
 *
 * Cosine rather than Euclidean distance because embeddings encode direction rather than magnitude, and
 * a long and a short phrasing of the same idea should score alike. Returns `0` for a zero-length
 * vector rather than `NaN`, so one degenerate input cannot poison a whole ranking.
 */
export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    dot += left * right
    normA += left * left
    normB += right * right
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Cosine similarity clamped to `[0, 1]`, for use as a ranking signal.
 *
 * **Not** the `(cos + 1) / 2` rescaling. That mapping looks harmless and is not: two unrelated
 * documents typically score around `0` cosine, which it inflates to `0.5`, so a genuinely relevant
 * match at `0.34` and an irrelevant one at `0.08` arrive as `0.67` and `0.54`. The difference the signal
 * exists to express is compressed into a few hundredths, and the ranking is then decided by whichever
 * other signal happens to have a wider range — which is how a hybrid retriever silently stops being
 * semantic. Clamping keeps "not similar" near zero and lets a real match stand out.
 *
 * Negative similarity becomes `0` rather than being allowed to cancel another signal in a weighted sum.
 */
export function similaritySignal(a: Vector, b: Vector): number {
  return Math.max(0, Math.min(1, cosineSimilarity(a, b)))
}

/** Whether a value looks like a usable vector. */
export function isVector(value: unknown): value is Vector {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'number')
  )
}
