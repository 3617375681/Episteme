import {
  EmbeddingError,
  cosineSimilarity,
  embeddingKeyFor,
  matchedTermsIn,
  similaritySignal,
  queryNodes,
  retrieve as coreRetrieve,
  termsOf,
  type ActorId,
  type CoreGraph,
  type EmbeddingAdapter,
  type EmbeddingCache,
  type EventLog,
  type BranchId,
  type GraphNode,
  type NodeId,
  type NodeTypeId,
  type RetrievedNode,
  type RetrievalResult,
  type Vector,
} from '@episteme/core'

/**
 * A retrieval request.
 *
 * Extends Core's `RetrievalQuery`, which carries the structural part — text, anchors, tags, node types,
 * depth, limit. A retriever adds only what it can use beyond structure.
 */
export interface RetrieveQuery {
  readonly text?: string
  readonly nodeIds?: readonly NodeId[]
  readonly tags?: readonly string[]
  readonly nodeTypes?: readonly NodeTypeId[]
  /** Whose understanding should inform ranking. Absent means structure only. */
  readonly actorId?: ActorId
  /** Hops of neighbourhood to include around a match. */
  readonly depth?: number
  readonly limit?: number
  /** Which signals to combine. Defaults to each retriever's own choice. */
  readonly signals?: readonly RankSignal[]
  /** Minimum combined score for a node to be reported. */
  readonly minScore?: number
}

/** The relevance signals a retriever may combine. See `docs/architecture/retrieval.md`. */
export type RankSignal = 'semantic' | 'lexical' | 'graph' | 'cognitive' | 'recency'

/**
 * The retrieval seam.
 *
 * Core's `retrieve()` is the lexical and neighbourhood primitive; this is the layer a *product* talks
 * to, so a second strategy can be added without a caller changing. It is asynchronous because
 * embeddings are, and because a synchronous signature would have to be broken later.
 *
 * `RetrievalResult` is Core's and stays stable. A retriever may attach scores; it may not change the
 * shape a caller reads.
 */
export interface Retriever {
  readonly name: string
  /** Short description of how it decides relevance, so a view can be honest about how it looked. */
  readonly description: string
  /**
   * Which signals this retriever actually uses.
   *
   * Declared so a caller can tell a semantic result from a lexical one without inspecting scores, and
   * so a hybrid implementation cannot quietly drop a signal it claims to combine.
   */
  readonly signals: readonly RankSignal[]
  retrieve(query: RetrieveQuery): Promise<RetrievalResult>
}

/** Weights for the hybrid score. See `docs/architecture/retrieval.md` for why these are not tuned. */
export interface HybridWeights {
  readonly semantic: number
  readonly lexical: number
  readonly graph: number
  readonly cognitive: number
  readonly recency: number
}

/**
 * First-pass weights, chosen to encode one requirement rather than to optimise a benchmark.
 *
 * The requirement is the project's central invariant: **semantic similarity must not be the only
 * meaningful signal.** Every weight is therefore within a factor of two of every other, so no single
 * term can decide a ranking on its own. That is a structural choice, not a tuned one — a semantic weight
 * an order of magnitude above the rest would be vector RAG with extra steps, which is exactly what this
 * project must not become.
 *
 * `recency` is the smallest because it is genuinely the weakest signal: a correction made a year ago may
 * still be the most relevant thing there is. It exists mainly to make the ordering total.
 *
 * These are deliberately not presented as optimal, and they were not tuned against a benchmark. What
 * they *are* is the point at which the semantic signal can do the job it exists for — an earlier
 * arrangement had it contributing under two percent of the total, which made the retriever hybrid in
 * name only. See `docs/architecture/retrieval.md`.
 */
export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = {
  semantic: 0.5,
  lexical: 0.15,
  graph: 0.15,
  cognitive: 0.15,
  recency: 0.05,
}

/**
 * Above this cosine similarity, a node is reported as a direct match rather than as something reached by
 * traversal.
 *
 * Without it, a semantic hit arrives in the `neighbors` group — the group that means "adjacent to
 * something you asked about" — which misdescribes *why* it is in the result. The threshold is low
 * because the deterministic adapter's vectors are sparse; a real model's would sit higher.
 */
export const SEMANTIC_MATCH_THRESHOLD = 0.2

/**
 * Scores one node against the query using whatever evidence is available.
 *
 * Each signal returns `[0, 1]` so the weighted sum stays interpretable, and every contribution is
 * recorded so a result can explain itself: a learner is entitled to know why a piece of their own past
 * understanding surfaced.
 */
export interface SignalContribution {
  readonly signal: RankSignal
  readonly weight: number
  readonly value: number
  /** `value * weight`, so the arithmetic in the total is visible rather than inferred. */
  readonly contribution: number
}

export interface ScoredCandidate {
  readonly node: GraphNode
  readonly score: number
  readonly contributions: readonly SignalContribution[]
  /** Query terms found literally, for the lexical signal's explanation. */
  readonly matchedTerms: readonly string[]
  readonly origin: 'match' | 'neighbor'
}

/**
 * The deterministic lexical retriever: terms, tags, anchors and graph neighbourhood.
 *
 * This is the Phase 0 behaviour, unchanged, behind the interface. No embeddings and no model: the same
 * question over the same graph returns the same thing in the same order, which is what lets a test
 * assert that a later interaction retrieved a specific piece of prior understanding.
 */
export class LexicalGraphRetriever implements Retriever {
  readonly name = 'lexical-graph'
  readonly description =
    'Matches the words in the question against labels, tags and ids, then walks the graph outward.'
  readonly signals: readonly RankSignal[] = ['lexical', 'graph']
  readonly #graph: CoreGraph

  constructor(graph: CoreGraph) {
    this.#graph = graph
  }

  retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    return Promise.resolve(
      coreRetrieve(this.#graph, {
        ...(query.text === undefined ? {} : { text: query.text }),
        ...(query.nodeIds === undefined ? {} : { nodeIds: query.nodeIds }),
        ...(query.tags === undefined ? {} : { tags: query.tags }),
        ...(query.nodeTypes === undefined ? {} : { nodeTypes: query.nodeTypes }),
        ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
        ...(query.depth === undefined ? {} : { depth: query.depth }),
        ...(query.minScore === undefined ? {} : { minScore: query.minScore }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    )
  }
}

/**
 * Shared candidate gathering for the retrievers.
 *
 * Every retriever must see candidates filtered the same way — drafts and retracted nodes excluded, node
 * types honoured — or two strategies would answer subtly different questions and could not be compared.
 *
 * Lexical matching is used as a *prefilter* only when no semantic signal is available. With embeddings
 * that would be wrong: a candidate sharing no words with the question is exactly the case semantic
 * retrieval exists to handle, and dropping it before scoring would make the embedding path useless for
 * the paraphrases it is meant to serve.
 */
function gatherCandidates(
  graph: CoreGraph,
  query: RetrieveQuery,
  options: { readonly prefilterLexically: boolean },
): {
  readonly reachable: readonly GraphNode[]
  readonly lexicalSeedIds: ReadonlySet<NodeId>
  readonly neighbors: readonly GraphNode[]
} {
  const all = queryNodes(graph.listNodes(), {
    ...(query.tags === undefined ? {} : { tags: query.tags }),
  }).filter((node) => {
    if (query.nodeTypes !== undefined && query.nodeTypes.length > 0) {
      return query.nodeTypes.includes(node.type)
    }
    return true
  })

  const text = query.text ?? ''
  const terms = termsOf(text)
  const lexicalSeedIds = new Set(
    terms.length === 0
      ? all.map((node) => node.id)
      : all.filter((node) => matchedTermsIn(node, terms).length > 0).map((node) => node.id),
  )

  const reachable = options.prefilterLexically
    ? all.filter((node) => lexicalSeedIds.has(node.id))
    : all

  // Traversal is used to *widen* a result, not to gate it: with semantic scoring every node is already
  // a candidate, so the neighbour pass only matters for the structural signals.
  const reachableIds = new Set(reachable.map((node) => node.id))
  const seeds = options.prefilterLexically ? [...reachableIds] : [...lexicalSeedIds]
  const seen = new Set<NodeId>(seeds)
  const neighbors: GraphNode[] = []
  const depth = query.depth ?? 1

  if (depth > 0 && seeds.length > 0) {
    let frontier: readonly NodeId[] = seeds
    let remaining = depth
    while (frontier.length > 0 && remaining > 0) {
      const next: NodeId[] = []
      for (const id of frontier) {
        for (const edge of graph.edgesOf(id)) {
          const other = edge.from === id ? edge.to : edge.from
          if (seen.has(other)) continue
          seen.add(other)
          const node = graph.getNode(other)
          if (node === undefined || node.revoked === true) continue
          if (node.meta.tier === 'draft') continue
          if (query.nodeTypes !== undefined && query.nodeTypes.length > 0) {
            if (!query.nodeTypes.includes(node.type)) {
              // Traverse through it so a two-hop relation stays reachable, but do not report it.
              next.push(other)
              continue
            }
          }
          neighbors.push(node)
          next.push(other)
        }
      }
      frontier = next
      remaining -= 1
    }
  }

  const outsideReach = neighbors.filter((node) => !reachableIds.has(node.id))
  return { reachable, lexicalSeedIds, neighbors: outsideReach }
}

/** Ranks candidates by embedding similarity alone. */
export class EmbeddingRetriever implements Retriever {
  readonly name = 'embedding'
  readonly description =
    'Cosine similarity between the question and each candidate, via an adapter.'
  readonly signals: readonly RankSignal[] = ['semantic']
  readonly #graph: CoreGraph
  readonly #adapter: EmbeddingAdapter
  readonly #cache: EmbeddingCache

  constructor(graph: CoreGraph, adapter: EmbeddingAdapter, cache: EmbeddingCache) {
    this.#graph = graph
    this.#adapter = adapter
    this.#cache = cache
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    const scored = await scoreSemantically(this.#graph, this.#adapter, this.#cache, query, {
      // Only the semantic weight is non-zero, so this is similarity ranking expressed through the same
      // path the hybrid retriever uses rather than a second implementation of it.
      semantic: 1,
      lexical: 0,
      graph: 0,
      cognitive: 0,
      recency: 0,
    })
    return toResult(query, scored)
  }
}

/**
 * Combines every available signal, including semantic similarity.
 *
 * This is the retriever a product should use. Its reason to exist is the project's invariant: semantic
 * similarity is one relevance signal, and the graph and the learner's own recorded state are evidence a
 * similarity score cannot see.
 */
export class HybridRetriever implements Retriever {
  readonly name = 'hybrid'
  readonly description =
    'Combines semantic similarity, lexical overlap, graph proximity, the learner\u2019s recorded state and recency.'
  readonly signals: readonly RankSignal[] = ['semantic', 'lexical', 'graph', 'cognitive', 'recency']
  readonly #graph: CoreGraph
  readonly #log: EventLog
  readonly #adapter: EmbeddingAdapter
  readonly #cache: EmbeddingCache
  readonly #weights: HybridWeights

  constructor(
    graph: CoreGraph,
    log: EventLog,
    adapter: EmbeddingAdapter,
    cache: EmbeddingCache,
    weights: HybridWeights = DEFAULT_HYBRID_WEIGHTS,
  ) {
    this.#graph = graph
    this.#log = log
    this.#adapter = adapter
    this.#cache = cache
    this.#weights = weights
  }

  get weights(): HybridWeights {
    return this.#weights
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    const scored = await scoreSemantically(
      this.#graph,
      this.#adapter,
      this.#cache,
      query,
      this.#weights,
      {
        log: this.#log,
      },
    )
    return toResult(query, scored)
  }
}

interface ScoringContext {
  /** Supplied only by a retriever that uses the cognitive signal; without it that signal is inactive. */
  readonly log: EventLog
  /** When given, only these signals contribute. Absent means every available signal. */
  readonly allow?: readonly RankSignal[]
}

/**
 * The one scoring path, used by both embedding-based retrievers.
 *
 * `EmbeddingRetriever` is this with only the semantic signal allowed, so the two cannot disagree about
 * candidate selection, similarity, or how a score becomes a `RetrievalResult`. Writing it twice is how
 * they would drift.
 */
async function scoreSemantically(
  graph: CoreGraph,
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  query: RetrieveQuery,
  weights: HybridWeights,
  context?: ScoringContext,
): Promise<readonly ScoredCandidate[]> {
  const text = query.text?.trim() ?? ''
  const allow = context?.allow === undefined ? undefined : new Set(context.allow)
  const wants = (signal: RankSignal): boolean => {
    if (query.signals !== undefined) return query.signals.includes(signal)
    if (allow !== undefined) return allow.has(signal)
    // No allowlist: every signal that has a source contributes. The cognitive signal has no source
    // without a log, which is why a semantic-only retriever simply does not pass one.
    return signal !== 'cognitive' || context?.log !== undefined
  }

  // Lexical matching is a prefilter only when no semantic signal will run; otherwise it would discard the
  // wordless-but-relevant candidates that embeddings exist to find.
  const { reachable, lexicalSeedIds, neighbors } = gatherCandidates(graph, query, {
    prefilterLexically: !wants('semantic'),
  })
  if (reachable.length === 0 && neighbors.length === 0) return []

  const candidates: readonly { readonly node: GraphNode; readonly origin: 'match' | 'neighbor' }[] =
    [
      ...reachable.map((node) => ({
        node,
        origin: lexicalSeedIds.has(node.id) ? ('match' as const) : ('neighbor' as const),
      })),
      ...neighbors.map((node) => ({ node, origin: 'neighbor' as const })),
    ]

  // The query vector is computed once. Empty text has nothing to embed, so only structural signals apply.
  const queryVector = text === '' ? undefined : await embedWithCache(adapter, cache, text)
  const terms = termsOf(text)
  const branchId =
    context === undefined ? undefined : context.log.currentBranch(query.actorId ?? graph.actorId).id
  const newest = newestCreatedAt(candidates.map((entry) => entry.node))
  const oldest = oldestCreatedAt(candidates.map((entry) => entry.node))
  const seedIds = new Set(
    candidates.filter((entry) => entry.origin === 'match').map((entry) => entry.node.id),
  )
  const hops = hopDistances(graph, seedIds, query.depth ?? 1)

  const scored: ScoredCandidate[] = []
  for (const candidate of candidates) {
    const { node } = candidate
    let origin = candidate.origin
    const contributions: SignalContribution[] = []
    const matchedTerms = matchedTermsIn(node, terms)

    if (queryVector !== undefined && wants('semantic')) {
      const vector = await embedWithCache(adapter, cache, textOfNode(node))
      const similarity = similaritySignal(queryVector, vector)
      push(contributions, 'semantic', weights.semantic, similarity)
      // A strong semantic hit *is* a match: reporting it as a neighbour would misdescribe why it is here.
      if (similarity >= SEMANTIC_MATCH_THRESHOLD) origin = 'match'
    }

    if (wants('lexical')) {
      push(contributions, 'lexical', weights.lexical, lexicalValue(node, terms, matchedTerms))
    }

    if (wants('graph')) {
      const distance = hops.get(node.id)
      push(contributions, 'graph', weights.graph, graphValue(distance, seedIds.has(node.id)))
    }

    if (context !== undefined && wants('cognitive')) {
      push(
        contributions,
        'cognitive',
        weights.cognitive,
        cognitiveValue(context.log, node.id, query.actorId, branchId),
      )
    }

    if (wants('recency')) {
      push(contributions, 'recency', weights.recency, recencyValue(node, oldest, newest))
    }

    const score = contributions.reduce((total, entry) => total + entry.contribution, 0)
    if (query.minScore !== undefined && score < query.minScore) continue
    scored.push({ node, score, contributions, matchedTerms, origin })
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    // A deterministic total order matters: retrieval is asserted in tests, and equal scores must not
    // reorder between runs.
    if (right.node.createdAt !== left.node.createdAt)
      return right.node.createdAt - left.node.createdAt
    return left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0
  })

  return query.limit === undefined ? scored : scored.slice(0, query.limit)
}

function push(into: SignalContribution[], signal: RankSignal, weight: number, value: number): void {
  into.push({ signal, weight, value, contribution: weight * value })
}

/** Reads a cached vector or computes and stores one. */
async function embedWithCache(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  text: string,
): Promise<Vector> {
  const key = embeddingKeyFor(text)
  const cached = cache.get(key, adapter.model)
  if (cached !== undefined) return cached

  const vector = await adapter.embed(text)
  if (vector.length === 0) {
    throw new EmbeddingError(
      'malformed_response',
      `adapter "${adapter.model}" returned an empty vector`,
      {
        model: adapter.model,
      },
    )
  }
  cache.set(key, adapter.model, vector)
  return vector
}

/**
 * The text of a node that gets embedded.
 *
 * Label plus properties plus tags: a claim's meaning lives in its label, but the tags carry topic and
 * scene, and dropping them would make two claims about different subjects look alike.
 */
export function textOfNode(node: GraphNode): string {
  const properties = Object.values(node.properties)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const tags = node.tags.map((tag) => tag.replace(/^[^:]*:/u, '')).join(' ')
  return `${node.label} ${properties} ${tags}`.trim()
}

/** Lexical overlap in `[0, 1]`: the fraction of query terms found in the node. */
function lexicalValue(
  node: GraphNode,
  terms: readonly string[],
  matchedTerms: readonly string[],
): number {
  if (terms.length === 0) return 0
  const label = node.label.toLowerCase()
  // A term in the label counts double, because a node *called* "RoPE" is more likely to be what a
  // question about RoPE means than one merely tagged `rope`.
  const weighted = matchedTerms.reduce((total, term) => total + (label.includes(term) ? 2 : 1), 0)
  return Math.min(1, weighted / (terms.length * 2))
}

/** Graph proximity in `[0, 1]`: a seed scores 1, and each hop decays. */
function graphValue(hops: number | undefined, isSeed: boolean): number {
  if (isSeed) return 1
  if (hops === undefined) return 0
  return 1 / (1 + hops)
}

/**
 * Recency in `[0, 1]`, positioned within the observed candidates rather than against the wall clock.
 *
 * Spread across the actual span so the signal is a genuine gradient rather than a lopsided ratio: with
 * `createdAt / newest`, every candidate in a graph written in one sitting scores almost 1 and the signal
 * carries no information while still consuming weight.
 */
function recencyValue(node: GraphNode, oldest: number, newest: number): number {
  if (newest <= oldest) return 1
  return Math.max(0, Math.min(1, (node.createdAt - oldest) / (newest - oldest)))
}

/**
 * The learner's recorded state as a relevance signal.
 *
 * Deliberately simple and deliberately *not* a pedagogical model. It answers one question: does this
 * node deserve to be in front of the learner again? Three things say yes, for different reasons:
 *
 * - **An open conflict** is the strongest: the agent must not build on a position the learner has
 *   themselves marked as contested, so it has to be surfaced even when the question does not name it.
 * - **Weak articulation with some confidence** is the situation a scaffold is for: the learner believes
 *   it and cannot say it.
 * - **Low confidence** means the ground is not solid, so re-surfacing it is useful rather than redundant.
 *
 * A claim the learner already holds with high confidence *and* good articulation is the least useful to
 * re-surface, and this signal scores it low — which is the opposite of a naive "strongly held is
 * relevant" rule, and the reason state is worth consulting at all.
 */
export function cognitiveValue(
  log: EventLog,
  nodeId: NodeId,
  actorId: ActorId | undefined,
  branchId: BranchId | undefined,
): number {
  if (actorId === undefined) return 0

  // A branch narrows the read to one line of inquiry. Without one — retrieval that is not scoped to a
  // branch — the unqualified read is correct, and passing `branchId: undefined` explicitly is not the
  // same thing as omitting it.
  const state =
    branchId === undefined
      ? log.stateOf(nodeId, actorId)
      : log.stateOf(nodeId, actorId, { branchId })
  if (state.size === 0) return 0

  const level = (dimension: string): string | undefined => state.get(dimension as never)?.level
  const confidence = level('confidence')
  const articulation = level('articulation')
  const conflict = level('conflict')

  let value = 0.2 // Recorded at all, so it is the learner's own understanding rather than a stranger's.
  if (conflict !== undefined && conflict !== 'none') value += 0.5
  if (confidence === 'low') value += 0.2
  else if (confidence === 'medium') value += 0.1
  if (articulation === 'low') value += 0.2
  else if (articulation === 'medium') value += 0.1

  // Already solid and sayable: nothing to add by showing it again.
  if (confidence === 'high' && articulation === 'high') value -= 0.2

  return Math.max(0, Math.min(1, value))
}

/** Hop count from the nearest seed, bounded by the requested depth. */
function hopDistances(
  graph: CoreGraph,
  seeds: ReadonlySet<NodeId>,
  depth: number,
): ReadonlyMap<NodeId, number> {
  const distances = new Map<NodeId, number>()
  let frontier: readonly NodeId[] = [...seeds]
  let distance = 0
  while (frontier.length > 0 && distance < depth) {
    distance += 1
    const next: NodeId[] = []
    for (const id of frontier) {
      for (const edge of graph.edgesOf(id)) {
        const other = edge.from === id ? edge.to : edge.from
        if (seeds.has(other) || distances.has(other)) continue
        distances.set(other, distance)
        next.push(other)
      }
    }
    frontier = next
  }
  return distances
}

function newestCreatedAt(nodes: readonly GraphNode[]): number {
  let newest = 0
  for (const node of nodes) if (node.createdAt > newest) newest = node.createdAt
  return newest
}

function oldestCreatedAt(nodes: readonly GraphNode[]): number {
  let oldest = Number.POSITIVE_INFINITY
  for (const node of nodes) if (node.createdAt < oldest) oldest = node.createdAt
  return Number.isFinite(oldest) ? oldest : 0
}

/** Turns scored candidates into the stable `RetrievalResult` shape a caller already reads. */
function toResult(query: RetrieveQuery, scored: readonly ScoredCandidate[]): RetrievalResult {
  const matches: RetrievedNode[] = []
  const neighbors: RetrievedNode[] = []
  for (const entry of scored) {
    const retrieved: RetrievedNode = {
      node: entry.node,
      matchedTerms: entry.matchedTerms,
      origin: entry.origin,
      score: entry.score,
    }
    if (entry.origin === 'match') matches.push(retrieved)
    else neighbors.push(retrieved)
  }

  const coreQuery = {
    ...(query.text === undefined ? {} : { text: query.text }),
    ...(query.nodeIds === undefined ? {} : { nodeIds: query.nodeIds }),
    ...(query.tags === undefined ? {} : { tags: query.tags }),
    ...(query.nodeTypes === undefined ? {} : { nodeTypes: query.nodeTypes }),
    ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    ...(query.depth === undefined ? {} : { depth: query.depth }),
  }

  // A node that was reached by traversal is a *neighbour* even if it also matched lexically; the groups
  // are a statement about how the result is ordered, and duplicating a node across them would make the
  // result ambiguous about which it is.
  const seen = new Set<NodeId>()
  const nodes: GraphNode[] = []
  for (const entry of matches) {
    if (seen.has(entry.node.id)) continue
    seen.add(entry.node.id)
    nodes.push(entry.node)
  }
  for (const entry of neighbors) {
    if (seen.has(entry.node.id)) continue
    seen.add(entry.node.id)
    nodes.push(entry.node)
  }

  return Object.freeze({
    query: coreQuery,
    terms: termsOf(query.text ?? ''),
    matches: Object.freeze(matches),
    neighbors: Object.freeze(neighbors),
    nodes: Object.freeze(nodes),
    nodeIds: Object.freeze(nodes.map((node) => node.id)),
  })
}

/** Convenience: the lexical retriever for a graph. */
export function lexicalRetriever(graph: CoreGraph): Retriever {
  return new LexicalGraphRetriever(graph)
}

/** Convenience: semantic-only retrieval over an adapter. */
export function embeddingRetriever(
  graph: CoreGraph,
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
): Retriever {
  return new EmbeddingRetriever(graph, adapter, cache)
}

/** Convenience: the retriever a product should use. */
export function hybridRetriever(
  graph: CoreGraph,
  log: EventLog,
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  weights?: HybridWeights,
): Retriever {
  return new HybridRetriever(graph, log, adapter, cache, weights ?? DEFAULT_HYBRID_WEIGHTS)
}

export { cosineSimilarity }
