import { retrieve } from '@episteme/core'
import type {
  CoreGraph,
  RetrievalQuery,
  RetrievalResult,
  RetrievedNode,
  NodeTypeId,
} from '@episteme/core'
import type { ActorId } from '@episteme/core'

/**
 * A retrieval request.
 *
 * Extends Core's `RetrievalQuery`, which already carries the structural part — text, anchors, tags,
 * node types, depth, limit. A retriever adds only what it can use beyond structure.
 */
export interface RetrieveQuery extends RetrievalQuery {
  /** Actor whose understanding should inform ranking. Absent means structure only. */
  readonly actorId?: ActorId
  /**
   * Ranking signals to apply.
   *
   * Explicit rather than implied, because "why did this come back first" is a question the learner is
   * entitled to ask, and a retriever must be able to answer it from what it was given.
   */
  readonly signals?: readonly RankSignal[]
}

/** The relevance signals a retriever may combine. See `docs/architecture/retrieval.md`. */
export type RankSignal = 'lexical' | 'graph' | 'actorState' | 'recency'

/**
 * The retrieval seam.
 *
 * Core's `retrieve()` is the lexical and neighbourhood primitive; this is the layer a *product* talks
 * to, so a second strategy can be added without a caller changing. It is deliberately asynchronous
 * even though the lexical implementation has nothing to await: a vector index or a remote service
 * would be, and a synchronous signature would have to be broken later.
 *
 * `RetrievalResult` is Core's and stays stable. A retriever may attach scores; it may not change the
 * shape a caller reads.
 */
export interface Retriever {
  readonly name: string
  /** Short description of how it decides relevance, so a view can be honest about how it looked. */
  readonly description: string
  retrieve(query: RetrieveQuery): Promise<RetrievalResult>
}

/**
 * The deterministic lexical retriever: terms, tags, anchors and graph neighbourhood.
 *
 * This is the Phase 0 behaviour, unchanged, behind the interface — so the existing contract keeps
 * working while a different strategy becomes possible. No embeddings and no model: the same question
 * over the same graph returns the same thing in the same order, which is what lets a test assert that
 * a later interaction retrieved a specific piece of prior understanding.
 */
export class LexicalGraphRetriever implements Retriever {
  readonly name = 'lexical-graph'
  readonly description =
    'Matches the words in the question against labels, tags and ids, then walks the graph outward.'
  readonly #graph: CoreGraph

  constructor(graph: CoreGraph) {
    this.#graph = graph
  }

  retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    return Promise.resolve(
      retrieve(this.#graph, {
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
 * Semantic retrieval over embeddings: **designed, not implemented.**
 *
 * It exists as a named shape so the intent is on the record and so nothing accidental grows in its
 * place. The reason to want it is concrete and measured: the lexical retriever matches words, so a
 * learner asking "why does order information survive in RoPE?" will not reach a claim phrased as
 * "self-attention alone does not encode sequence order". Everything downstream of retrieval inherits
 * that weakness, which makes this the highest-value next slice.
 *
 * The interface is satisfied by construction — implementing it means writing the body. Two constraints
 * are already settled, and they are why this is not merely "add vectors":
 *
 * 1. **It stays one signal among several.** See `docs/architecture/retrieval.md`: graph proximity and
 *    the actor's own recorded state are relevance evidence a similarity score cannot see, and ranking
 *    on similarity alone turns Episteme into ordinary vector RAG over a personal corpus.
 * 2. **It stays explainable.** A learner is entitled to know why their own past understanding
 *    surfaced. `RetrievedNode.matchedTerms` is empty for a semantic match, so the implementation owes
 *    the result *some* account of itself — at minimum the score and which signals contributed — rather
 *    than a bare number.
 *
 * Rejection rather than an empty result is deliberate: a caller that forgot to configure embeddings
 * would otherwise silently receive no context and conclude that the learner understands nothing.
 */
export class EmbeddingRetriever implements Retriever {
  readonly name = 'embedding'
  readonly description =
    'Semantic similarity over an embedding index, combined with graph proximity and actor state.'

  retrieve(_query: RetrieveQuery): Promise<RetrievalResult> {
    return Promise.reject(
      new Error(
        'EmbeddingRetriever is designed but not implemented. Retrofitting means adding an embedding port, folding a similarity term into the existing score, and keeping the other signals — see docs/architecture/retrieval.md.',
      ),
    )
  }
}

/** A retriever bound to one graph, for callers that do not want to pass the graph each time. */
export function bindRetriever(retriever: Retriever, _graph: CoreGraph): Retriever {
  return retriever
}

/** Convenience: the lexical retriever for a graph. */
export function lexicalRetriever(graph: CoreGraph): Retriever {
  return new LexicalGraphRetriever(graph)
}

export type { NodeTypeId, RetrievalResult, RetrievedNode }
