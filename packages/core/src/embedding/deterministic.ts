import { isStopWord } from '../retrieval/index.js'
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
 * Chinese terms mapped onto the English vocabulary the lexicon already knows.
 *
 * This exists because of a defect that only appeared once learners were given a Chinese interface: a Chinese
 * question produced **no semantic signal at all**. Every result sat at exactly the recency floor, because
 * `tokensOf` splits on non-letter characters and Chinese has no spaces — the whole question arrived as one
 * token, shared no vocabulary with any English label, and scored zero against everything.
 *
 * A bilingual interface over a monolingual retriever is worse than either alone: it looks like it works and
 * quietly returns nothing.
 *
 * Matching is **longest-first**, so `位置编码` resolves as one term rather than as `位置` plus `编码`, which
 * would lose the compound's meaning. Values are the same canonical tokens `EXPANDED_TERMS` uses, so a Chinese
 * question and an English one land in the same place in the vector space. That is also why a Chinese question
 * can retrieve an English-labelled node and the reverse.
 */
export const CHINESE_TERMS: Readonly<Record<string, readonly string[]>> = {
  // Order, position and sequence.
  顺序: ['order', 'sequence', 'position', 'index'],
  次序: ['order', 'sequence', 'position', 'index'],
  序列: ['order', 'sequence', 'position', 'index'],
  位置: ['order', 'sequence', 'position', 'index'],
  位置编码: ['order', 'sequence', 'position', 'index', 'encode'],
  绝对位置: ['absolute', 'index'],
  相对位置: ['relative', 'rope'],
  相对: ['relative', 'rope'],
  第几: ['order', 'sequence', 'position', 'index'],
  先后: ['order', 'sequence', 'position', 'index'],
  排序: ['order', 'sequence', 'position', 'index'],
  排列: ['permutation', 'invariance', 'shuffle'],
  置换: ['permutation', 'invariance'],
  置换不变性: ['permutation', 'invariance'],
  不变: ['invariance'],
  不变性: ['permutation', 'invariance'],
  打乱: ['permutation', 'invariance', 'shuffle'],

  // Attention.
  注意力: ['attention', 'self-attention', 'token'],
  自注意力: ['attention', 'self-attention', 'token'],
  注意力头: ['attention', 'head'],
  多头: ['attention', 'head'],
  头: ['attention', 'head'],

  // Encoding and representation.
  编码: ['encode', 'representation', 'inject'],
  表示: ['encode', 'representation', 'inject'],
  注入: ['encode', 'representation', 'inject'],
  加上: ['encode', 'representation', 'inject'],
  叠加: ['encode', 'representation', 'inject'],
  旋转: ['relative', 'rotation', 'rope'],
  旋转位置编码: ['relative', 'rotation', 'rope'],

  // Tokens and input.
  词: ['token', 'word', 'input'],
  词元: ['token', 'word', 'input'],
  输入: ['token', 'word', 'input'],
  字符: ['token', 'word', 'input'],

  // Architecture.
  模型: ['transformer', 'model', 'architecture'],
  架构: ['transformer', 'model', 'architecture'],
  变压器: ['transformer', 'model', 'architecture'],

  // Questions and reasons.
  为什么: ['why', 'reason', 'necessary'],
  原因: ['why', 'reason', 'necessary'],
  为何: ['why', 'reason', 'necessary'],
  需要: ['why', 'reason', 'necessary', 'need'],
  必须: ['why', 'reason', 'necessary', 'need'],

  // Verbs that carry meaning in a question.
  知道: ['encode', 'representation'],
  告诉: ['encode', 'representation', 'inject'],
  区分: ['order', 'sequence'],
  丢失: ['order', 'sequence', 'invariance'],
  丢失了: ['order', 'sequence', 'invariance'],
  处理: ['encode', 'representation'],
  理解: ['encode', 'representation'],
  影响: ['why', 'reason'],
}

/**
 * Splits text into tokens **for retrieval**, applying the stop list and the Chinese lexicon.
 *
 * This is the function a retriever should use. `lexiconTokens` alone segments both languages but does not
 * filter, and using it directly produced a real regression: `"in"`, `"the"` and `"to"` became match terms, so
 * `"What is the capital of Portugal?"` matched two claims through the word "the" and a hard negative outranked
 * the expected node in four of six evaluation cases.
 *
 * The lesson is in the composition rather than either part: segmentation without filtering is not the same
 * lexical signal the retriever had before, and swapping one for the other silently changed what counts as a
 * match.
 */
export function retrievalTokens(text: string): readonly string[] {
  return lexiconTokens(text).filter((token) => !isStopWord(token) && !CHINESE_STOP_WORDS.has(token))
}

/**
 * Chinese words that carry no retrieval signal.
 *
 * Chinese has no spaces, so a question arrives as segmented words and the particles survive segmentation —
 * `的`, `是`, `在` would otherwise become match terms exactly as `"the"` and `"in"` did for English.
 */
export const CHINESE_STOP_WORDS: ReadonlySet<string> = new Set([
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '就',
  '都',
  '也',
  '还',
  '很',
  '会',
  '能',
  '要',
  '把',
  '被',
  '让',
  '给',
  '对',
  '为',
  '以',
  '及',
  '或',
  '而',
  '之',
  '它',
  '他',
  '我',
  '你',
  '这',
  '那',
  '哪',
  '什么',
  '怎么',
  '如何',
  '多少',
  '一个',
  '一下',
  '到底',
  '其实',
  '可以',
  '是否',
])

/**
 * Splits text into tokens, segmenting CJK runs against the Chinese lexicon by longest match.
 *
 * Latin text keeps the whitespace-and-punctuation split. CJK runs are matched longest-first, and any
 * character not covered is kept as its own token so an unknown word still contributes something rather than
 * being dropped. Filtering is **not** applied here — a tokenizer that also decides relevance is two concerns
 * in one function; use `retrievalTokens` when you want the retrieval signal.
 */
export function lexiconTokens(text: string): readonly string[] {
  const lower = text.toLowerCase()
  const out: string[] = []

  // A CJK run is a maximal sequence of CJK characters, optionally with a parenthesised Latin gloss between
  // them — which is exactly how the seeded labels are written, e.g. `自注意力（Self-Attention）`.
  const segments = lower.split(/([\u3400-\u9fff\u3040-\u30ff]+)/u)

  for (const segment of segments) {
    if (segment === '') continue
    if (!/[\u3400-\u9fff\u3040-\u30ff]/u.test(segment)) {
      out.push(...tokensOf(segment))
      continue
    }
    out.push(...segmentChinese(segment))
  }

  return out
}

/** Longest-match segmentation of one CJK run against the Chinese lexicon. */
function segmentChinese(run: string): readonly string[] {
  const out: string[] = []
  let index = 0
  while (index < run.length) {
    let matched = ''
    // Longest first, so a compound beats its parts.
    for (let length = Math.min(8, run.length - index); length >= 2; length -= 1) {
      const candidate = run.slice(index, index + length)
      if (CHINESE_TERMS[candidate] !== undefined) {
        matched = candidate
        break
      }
    }
    out.push(matched === '' ? (run[index] ?? '') : matched)
    index += matched === '' ? 1 : matched.length
  }
  return out
}

/** The vocabulary a token should be compared in, spanning both languages. */
export function lexiconTermsOf(token: string): readonly string[] {
  const chinese = CHINESE_TERMS[token]
  if (chinese !== undefined) return [token, ...chinese]
  return expandedTermsOf(token)
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

    for (const token of lexiconTokens(text)) {
      for (const term of lexiconTermsOf(token)) {
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
