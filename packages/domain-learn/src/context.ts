import type {
  ActorId,
  CoreGraph,
  EventLog,
  GraphNode,
  NodeId,
  RetrievalQuery,
  StateValue,
} from '@episteme/core'
import { LexicalGraphRetriever, type RankSignal, type Retriever } from './retriever.js'

/**
 * What the learner already understands, as far as this query is concerned.
 *
 * One entry per retrieved node that this actor has actually recorded something about. The
 * point of the whole retrieval layer is the `known` map: without it a later interaction can
 * only see what is in front of it, and the project's central claim is that it can see what
 * was understood before.
 */
export interface KnownUnderstanding {
  readonly nodeId: NodeId
  readonly label: string
  readonly type: string
  readonly state: Readonly<Record<string, StateValue>>
  /**
   * Whether the learner holds this with enough confidence to build on it.
   *
   * A deliberately small, readable predicate: the agent uses it to decide whether to explain
   * a foundation or start from it. It is *not* a mastery score — it is a reading of one
   * dimension, and it stays explainable.
   */
  readonly settled: boolean
  /** Dimensions the learner currently has marked as conflicting, if any. */
  readonly openConflicts: readonly string[]
}

export interface RelevantContext {
  readonly question: string
  readonly actorId: ActorId | undefined
  /** Terms the query was reduced to, so the retrieval can be explained. */
  readonly terms: readonly string[]
  /** Every node the retrieval surfaced, in ranked order. */
  readonly nodes: readonly GraphNode[]
  /** What this actor already understands about those nodes. */
  readonly known: readonly KnownUnderstanding[]
  /** One-line rendering, used by the demo and by the agent's own reasoning. */
  readonly summary: string
  readonly query: RetrievalQuery
  /** Which retriever produced this, so a view can be honest about how it looked. */
  readonly retriever: string
}

/**
 * Dimensions in which a "high-ish" reading means the learner can build on this.
 *
 * Read from the request rather than hard-coded into a wider rule, because which axes matter
 * is exactly the kind of judgement a domain pack owns.
 */
const SETTLED_DIMENSIONS: Readonly<Record<string, readonly string[]>> = {
  confidence: ['medium', 'high'],
  articulation: ['medium', 'high'],
}

export interface RetrieveContextOptions {
  readonly actorId?: ActorId
  readonly tags?: readonly string[]
  readonly nodeTypes?: RetrievalQuery['nodeTypes']
  readonly depth?: number
  readonly limit?: number
  /**
   * The strategy to use.
   *
   * Defaults to the deterministic lexical retriever. Passing another is how a different relevance
   * model is adopted without any caller changing — see `Retriever` in `retriever.ts`.
   */
  readonly retriever?: Retriever
  /**
   * Which signals to combine, when the retriever supports a choice.
   *
   * Exposed here so a caller can ask "what would lexical alone have found?" without a second code path:
   * a demo or a test can run the same question through different signal sets and compare.
   */
  readonly signals?: readonly RankSignal[]
}

/**
 * Retrieves the cognitive context relevant to a question.
 *
 * Two things are joined here, and the join is the point: `retrieve` finds the relevant part
 * of the *graph*, and the event history says what *this actor* understands about it. A
 * concept is shared; the understanding of it is not, so this function must never mix one
 * actor's state into another's context.
 *
 * Deterministic by construction when the default retriever is used — the same question over the same
 * history always yields the same context, which is what lets the critical loop be asserted in a test
 * rather than demonstrated by hand.
 */
export function retrieveRelevantContext(
  graph: CoreGraph,
  log: EventLog,
  question: string,
  options: RetrieveContextOptions = {},
): Promise<RelevantContext> {
  return retrieveWith(
    options.retriever ?? new LexicalGraphRetriever(graph),
    graph,
    log,
    question,
    options,
  )
}

/**
 * Retrieves context through a named retriever.
 *
 * The one place the join happens, so every strategy — lexical now, semantic later — produces the same
 * `RelevantContext` shape and inherits the same actor isolation.
 */
export async function retrieveWith(
  retriever: Retriever,
  graph: CoreGraph,
  log: EventLog,
  question: string,
  options: RetrieveContextOptions = {},
): Promise<RelevantContext> {
  const result = await retriever.retrieve({
    text: question,
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.nodeTypes === undefined ? {} : { nodeTypes: options.nodeTypes }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    depth: options.depth ?? 1,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })

  const actorId = options.actorId
  const known: KnownUnderstanding[] = []
  if (actorId !== undefined) {
    for (const node of result.nodes) {
      // The node may already be gone from a later projection, so resolve it through the
      // graph rather than trusting the retrieval snapshot.
      const current = graph.getNode(node.id) ?? node
      const state = log.stateOf(current.id, actorId)
      if (state.size === 0) continue

      const record: Record<string, StateValue> = {}
      const openConflicts: string[] = []
      let settled = false

      for (const [dimension, value] of state) {
        record[dimension] = value
        if (dimension === 'conflict' && value.level !== undefined && value.level !== 'none') {
          openConflicts.push(value.level)
        }
        const levels = SETTLED_DIMENSIONS[dimension]
        if (levels !== undefined && value.level !== undefined && levels.includes(value.level)) {
          settled = true
        }
      }

      known.push({
        nodeId: current.id,
        label: current.label,
        type: current.type,
        state: Object.freeze(record),
        settled,
        openConflicts: Object.freeze(openConflicts),
      })
    }
  }

  return Object.freeze({
    question,
    actorId,
    terms: result.terms,
    nodes: result.nodes,
    known: Object.freeze(known),
    summary: summarise(known),
    query: result.query,
    retriever: retriever.name,
  })
}

/**
 * Renders prior understanding as one line.
 *
 * Returns an empty string when nothing is recorded. That is deliberate: "nothing" must be
 * distinguishable from "something" *as data*, because a responder branches on whether it has
 * anything to build from. Prose for the empty case belongs to `contextSummary` instead, so a
 * human-readable phrase can never be mistaken for recorded understanding.
 */
export function summarise(known: readonly KnownUnderstanding[]): string {
  if (known.length === 0) return ''

  return known
    .map((entry) => {
      const levels = Object.entries(entry.state)
        .map(([dimension, value]) => `${dimension}=${value.level ?? value.scalar ?? '?'}`)
        .sort()
        .join(', ')
      const conflicts =
        entry.openConflicts.length > 0 ? ` (unresolved: ${entry.openConflicts.join('/')})` : ''
      return `${entry.label} [${levels}]${conflicts}`
    })
    .join('; ')
}

/** A display form of the summary that reads sensibly when nothing is recorded. */
export function contextSummary(context: RelevantContext): string {
  return context.summary === '' ? 'nothing is recorded about this yet' : context.summary
}

/** The subset of prior understanding the learner appears ready to build on. */
export function settledUnderstanding(context: RelevantContext): readonly KnownUnderstanding[] {
  return context.known.filter((entry) => entry.settled)
}

/** Whether the learner has already recorded an unresolved conflict anywhere in this context. */
export function hasOpenConflict(context: RelevantContext): boolean {
  return context.known.some((entry) => entry.openConflicts.length > 0)
}

/**
 * Answers a learner's question from what they already understand.
 *
 * This is a deterministic stand-in for a model, and it is written to make the critical
 * property *legible*: the three branches below differ in structure, not just in wording. With
 * no recorded understanding the answer has to establish the ground; with understanding it
 * starts from it; with an unresolved conflict it refuses to build on a position the learner
 * has themselves marked as contested. A real model would be plugged in behind the same
 * interface, and this is the behaviour it would have to reproduce.
 *
 * Deliberately kept here rather than in `@episteme/agent`: the wording is Learn's, and the
 * agent package must not learn Learn's vocabulary.
 */
export function learnerResponder(
  input: { readonly text: string },
  context: {
    readonly summary?: string
    readonly detail?: Readonly<Record<string, unknown>>
  },
): { text: string; usedContext: boolean; contextSummary?: string } {
  const summary = context.summary?.trim() ?? ''
  const detail = context.detail

  if (summary === '') {
    return {
      text: `Let's build the foundation first. ${input.text} — to answer that we should start with what self-attention can and cannot represent, because the question only makes sense once that is clear.`,
      usedContext: false,
    }
  }

  const openConflicts = readStringArray(detail?.['openConflicts'])

  if (openConflicts.length > 0) {
    return {
      text: `You have recorded an unresolved conflict here (${openConflicts.join(', ')}), so I will not build on it as settled. ${input.text} — the useful next step is to state precisely which case your current position does not cover.`,
      usedContext: true,
      contextSummary: summary,
    }
  }

  const settledLabels = readStringArray(detail?.['settledLabels'])

  if (settledLabels.length === 0) {
    return {
      text: `We have a start on this (${summary}), but nothing you have marked as settled yet. ${input.text} — let us pin down which part you would defend before going further.`,
      usedContext: true,
      contextSummary: summary,
    }
  }

  return {
    text: `Since you already understand that ${settledLabels.join(' and ')}, let's go straight to ${input.text} without re-deriving the groundwork.`,
    usedContext: true,
    contextSummary: summary,
  }
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Adapts retrieved learner context into the agent-facing shape.
 *
 * The concrete prior understanding travels in `detail` rather than being flattened into the
 * summary, so a responder can branch on *which* understanding exists instead of pattern
 * matching prose it wrote itself a moment earlier.
 */
export function toAgentContext(context: RelevantContext): {
  summary: string
  nodeIds: readonly NodeId[]
  detail: Readonly<Record<string, unknown>>
} {
  return {
    summary: context.summary,
    nodeIds: context.nodes.map((node) => node.id),
    detail: {
      settledLabels: settledUnderstanding(context).map((entry) => entry.label),
      openConflicts: [...new Set(context.known.flatMap((entry) => entry.openConflicts))],
      known: context.known,
      terms: context.terms,
    },
  }
}
