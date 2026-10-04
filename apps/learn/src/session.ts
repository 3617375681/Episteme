import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  type ActorId,
  type DimensionId,
  type EdgeId,
  type EmbeddingAdapter,
  type GraphNode,
  type NodeId,
  type StateValue,
} from '@episteme/core'
import {
  DIMENSION,
  EDGE,
  HybridRetriever,
  NODE,
  contextSummary,
  learnerResponder,
  learnTags,
  retrieveWith,
  toAgentContext,
  type RankedEntry,
  type RelevantContext,
  type Retriever,
} from '@episteme/domain-learn'
import { MockCognitiveAgent } from '@episteme/agent'
import { agentActor, humanActor, openEpisteme, type Episteme } from '@episteme/sdk'
import { openLocalStorage } from '@episteme/storage-local'

/**
 * The Learn interaction session.
 *
 * This is the smallest surface on which the project's claim can actually be used rather than asserted:
 * a learner asks, sees which of their own prior understanding was retrieved **and why**, records what
 * they now understand, and the next answer is built on it.
 *
 * Three deliberate properties:
 *
 * 1. **Every answer is produced by the same retrieval that is displayed.** The reasons shown are the
 *    contributions that produced the ranking shown, from one call. A view that showed reasons fetched
 *    separately could disagree with the order next to them.
 * 2. **The agent cannot write.** Recording understanding goes through `record()`, which commits a
 *    `StateEvent` authored by the *human*; the agent only ever supplies answer text. The
 *    `core/ai-cannot-author-state` guard enforces this, and nothing here bypasses it.
 * 3. **Nothing is held only in memory.** Every recorded understanding is persisted, so the session can be
 *    closed and reopened, which is the whole point of the earlier phases.
 */

const HUMAN = asId<ActorId>('actor_human')
const SCAFFOLD = asId<ActorId>('actor_scaffold')

/** A dimension the learner can record, with the levels the domain pack allows. */
export interface RecordableDimension {
  readonly id: DimensionId
  readonly label: string
  readonly levels: readonly string[]
  readonly description: string
}

/**
 * The dimensions a learner may set from this surface, in the order they are offered.
 *
 * Deliberately a subset of the registered axes. The others are recorded by other means or are not yet
 * settable by hand, and offering a control for a dimension whose meaning is unclear would invite the
 * learner to record something they cannot interpret later.
 */
export const RECORDABLE_DIMENSIONS: readonly RecordableDimension[] = [
  {
    id: DIMENSION.confidence,
    label: 'Confidence',
    levels: ['low', 'medium', 'high'],
    description: 'How much you would rely on this.',
  },
  {
    id: DIMENSION.articulation,
    label: 'Articulation',
    levels: ['low', 'medium', 'high'],
    description: 'How well you could explain it to someone else.',
  },
  {
    id: DIMENSION.evidence,
    label: 'Evidence',
    levels: ['none', 'weak', 'reproduced', 'derived'],
    description: 'What backs it up.',
  },
  {
    id: DIMENSION.conflict,
    label: 'Conflict',
    levels: ['none', 'open', 'resolved'],
    description: 'Whether you hold something that contradicts it.',
  },
]

/** One retrieved node, with everything a view needs to justify its position. */
export interface RankedView {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly score: number
  readonly origin: 'match' | 'neighbor'
  readonly matchedTerms: readonly string[]
  /** The contributions that produced the score, largest first. */
  readonly reasons: readonly ReasonView[]
}

export interface ReasonView {
  readonly signal: string
  readonly value: number
  readonly weight: number
  readonly contribution: number
  /** Share of the total score, so the display can show what dominated. */
  readonly share: number
  /** How this signal is being read, in the learner's terms. */
  readonly explanation: string
}

/** What this actor has recorded about one retrieved node. */
export interface UnderstandingView {
  readonly nodeId: string
  readonly label: string
  readonly settled: boolean
  readonly openConflicts: readonly string[]
  readonly dimensions: readonly { readonly id: string; readonly level: string }[]
}

export interface AskResult {
  readonly question: string
  readonly answer: string
  /** Whether the answer was shaped by recorded prior understanding. Data, not prose. */
  readonly usedContext: boolean
  readonly retriever: string
  readonly summary: string
  readonly known: readonly UnderstandingView[]
  readonly ranked: readonly RankedView[]
  readonly rules: readonly RankRule[]
}

/** The scoring model, echoed so the surface can be honest about how relevance was decided. */
export interface RankRule {
  readonly signal: string
  readonly weight: number
}

export interface NodeView {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly tier: string
  readonly tags: readonly string[]
}

export interface SessionOptions {
  /** Where the graph lives. Without one, the session is in memory and loses everything on exit. */
  readonly filePath?: string
  readonly adapter?: EmbeddingAdapter
  readonly weights?: ConstructorParameters<typeof HybridRetriever>[4]
}

/**
 * A live Learn session.
 *
 * Holds one composed instance and one retriever, so every call reads the same graph and the same event
 * history. Rebuilding the retriever per call would reintroduce the possibility of a display that does not
 * match the answer it accompanies.
 */
export class LearnSession {
  readonly #episteme: Episteme
  readonly #retriever: Retriever
  readonly #agent = new MockCognitiveAgent({ responder: learnerResponder })
  readonly #store: { save(state?: unknown): Promise<void> } | undefined
  #saveChain: Promise<void> = Promise.resolve()

  private constructor(
    episteme: Episteme,
    retriever: Retriever,
    store?: { save(state?: unknown): Promise<void> },
  ) {
    this.#episteme = episteme
    this.#retriever = retriever
    this.#store = store
  }

  /**
   * Opens a session, reading any existing history first.
   *
   * The ordering — load, then compose — is the rule `@episteme/sdk` exists to hold, so this does not
   * repeat it.
   */
  static async open(options: SessionOptions = {}): Promise<LearnSession> {
    const actors = [humanActor(HUMAN), agentActor(SCAFFOLD)]
    const adapter = options.adapter ?? new DeterministicEmbeddingAdapter()

    if (options.filePath === undefined) {
      const { compose } = await import('@episteme/sdk')
      const episteme = compose({ actors, actorId: HUMAN })
      return new LearnSession(
        episteme,
        new HybridRetriever(
          episteme.graph,
          episteme.log,
          adapter,
          new InMemoryEmbeddingCache(),
          ...(options.weights === undefined ? [] : [options.weights]),
        ),
      )
    }

    const storage = await openLocalStorage(options.filePath)
    const episteme = await openEpisteme(storage, { actors, actorId: HUMAN })
    return new LearnSession(
      episteme,
      new HybridRetriever(
        episteme.graph,
        episteme.log,
        adapter,
        new InMemoryEmbeddingCache(),
        ...(options.weights === undefined ? [] : [options.weights]),
      ),
      storage,
    )
  }

  get actorId(): ActorId {
    return HUMAN
  }

  get graph(): Episteme['graph'] {
    return this.#episteme.graph
  }

  /**
   * The event history, for a view or a test that needs to read it.
   *
   * Exposed read-only in spirit: nothing in this app writes to it except `record()`, which authors as the
   * human. Handing out the log is safe precisely because Core's guards reject a non-human author, so there
   * is no path through it that lets an agent write the learner's understanding.
   */
  get log(): Episteme['log'] {
    return this.#episteme.log
  }

  get retrieverName(): string {
    return this.#retriever.name
  }

  get rules(): readonly RankRule[] {
    if (this.#retriever instanceof HybridRetriever) {
      const weights = this.#retriever.weights
      return (Object.entries(weights) as [string, number][]).map(([signal, weight]) => ({
        signal,
        weight,
      }))
    }
    return []
  }

  get eventCount(): number {
    return this.#episteme.log.eventCount
  }

  /**
   * Asks a question and returns the answer together with the evidence behind it.
   *
   * One retrieval produces both the ranking shown and the context the answer was conditioned on, so the
   * two cannot disagree.
   */
  async ask(question: string): Promise<AskResult> {
    const context = await retrieveWith(
      this.#retriever,
      this.#episteme.graph,
      this.#episteme.log,
      question,
      { actorId: HUMAN, depth: 1, limit: 8 },
    )

    const response = await this.#agent.respond({ text: question }, toAgentContext(context))

    return {
      question,
      answer: response.text,
      usedContext: response.usedContext,
      retriever: context.retriever,
      // The display form, so the surface never has to decide what "nothing recorded" reads like.
      summary: contextSummary(context),
      known: context.known.map((entry) => ({
        nodeId: entry.nodeId,
        label: entry.label,
        settled: entry.settled,
        openConflicts: entry.openConflicts,
        dimensions: Object.entries(entry.state)
          .map(([id, value]: [string, StateValue]) => ({
            id,
            level: value.level ?? String(value.scalar ?? '?'),
          }))
          .sort((left, right) => (left.id < right.id ? -1 : 1)),
      })),
      ranked: toRankedView(context),
      rules: this.rules,
    }
  }

  /**
   * Records what the learner now understands about a node.
   *
   * Authored by the human, always: there is no parameter for an actor, because a surface that let a
   * caller pass one would be one refactor away from letting the agent write the learner's understanding.
   * The commit is validated by Core's guards like any other.
   */
  async record(
    target: NodeId | string,
    dimensions: Readonly<Record<string, string>>,
    options: { readonly reason?: string } = {},
  ): Promise<{
    readonly eventId: string
    readonly recorded: readonly { id: string; level: string }[]
  }> {
    const entries = Object.entries(dimensions).filter(([, level]) => level !== '')
    if (entries.length === 0) {
      throw new Error('record needs at least one dimension')
    }

    for (const [dimension] of entries) {
      const known = RECORDABLE_DIMENSIONS.find((candidate) => candidate.id === dimension)
      if (known === undefined) {
        throw new Error(
          `"${dimension}" is not recordable from this surface. Available: ${RECORDABLE_DIMENSIONS.map((d) => d.id).join(', ')}`,
        )
      }
    }

    const event = this.#episteme.log.commit({
      target: asId<NodeId>(target),
      actorId: HUMAN,
      dimensions: new Map(
        entries.map(([dimension, level]): [DimensionId, StateValue] => [
          asId<DimensionId>(dimension),
          { level },
        ]),
      ),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      source: 'learn-surface',
    })

    await this.flush()

    return {
      eventId: event.id,
      recorded: entries.map(([id, level]) => ({ id, level })),
    }
  }

  /**
   * Adds a claim or concept the learner is working with, so the graph is theirs rather than a fixture.
   *
   * Only the kinds a learner actually writes are accepted here. Anything else — evidence, synthesis, raw
   * notes — has its own lifecycle, and a surface that let a learner create all nine node types from one
   * text box would be teaching them the ontology instead of the subject.
   */
  async addNode(input: {
    readonly label: string
    readonly kind: 'claim' | 'concept' | 'question'
    readonly topic?: string
    readonly source?: string
    /** Supplied when the caller needs a stable id, such as a topic seeder that must be idempotent. */
    readonly id?: string
  }): Promise<NodeView> {
    const node = this.addNodeSync({
      id: input.id ?? this.#nextId(input.kind),
      label: input.label,
      type:
        input.kind === 'claim'
          ? NODE.claim
          : input.kind === 'concept'
            ? NODE.concept
            : NODE.question,
      // A concept the learner introduces is reference material; a claim is their own thinking. The tier
      // decides whether it counts as understanding, so it is not a cosmetic field.
      tier: input.kind === 'concept' ? 'reference' : 'thought',
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.source === undefined ? {} : { source: input.source }),
    })
    await this.flush()
    return node
  }

  /**
   * A short id derived from the kind of node and how many of that kind already exist.
   *
   * Short because these ids are typed by hand: the surface asks a learner to name a node when recording
   * their understanding, and the first version used a slug of the label, which produced
   * `node_0_self_attention_cannot_tell_which_word_ca` — truncated mid-word and impractical to type. A
   * learner's own vocabulary should not be turned into an identifier they cannot say.
   */
  #nextId(kind: 'claim' | 'concept' | 'question'): string {
    const prefix = `${kind}_`
    let highest = 0
    for (const node of this.#episteme.graph.listNodes()) {
      if (!node.id.startsWith(prefix)) continue
      const suffix = Number.parseInt(node.id.slice(prefix.length), 10)
      if (Number.isFinite(suffix) && suffix > highest) highest = suffix
    }
    return `${prefix}${highest + 1}`
  }

  /**
   * Resolves a node the learner referred to by id or by an unambiguous prefix.
   *
   * Returns every match rather than guessing, so an ambiguous prefix produces a message naming the
   * candidates instead of silently recording understanding against the wrong node — which would be a
   * permanent, validated, wrong fact in their history.
   */
  resolveNodes(reference: string): readonly NodeView[] {
    const nodes = this.listNodes()
    const exact = nodes.find((node) => node.nodeId === reference)
    if (exact !== undefined) return [exact]
    return nodes.filter((node) => node.nodeId.startsWith(reference))
  }

  /**
   * The unflushed half of `addNode`.
   *
   * Exists so a batch — seeding a topic — is one write rather than one write per node. Callers that use it
   * must `flush()` themselves; every path in this file that does is listed next to its `flush()` call.
   */
  addNodeSync(input: {
    readonly id: string
    readonly label: string
    readonly type: Parameters<Episteme['graph']['addNode']>[0]['type']
    readonly tier: 'draft' | 'thought' | 'reference'
    readonly topic?: string
    readonly source?: string
  }): NodeView {
    const label = input.label.trim()
    if (label === '') throw new Error('a node needs a label')

    const node = this.#episteme.graph.addNode({
      id: asId<NodeId>(input.id),
      type: input.type,
      label,
      properties: { text: label },
      tags: learnTags(input.topic ?? 'general'),
      tier: input.tier,
      ...(input.source === undefined ? {} : { source: input.source }),
    })

    return this.#view(node)
  }

  /** Links two nodes, so a claim can be anchored and graph proximity has something to work with. */
  async link(
    from: string,
    to: string,
    type = EDGE.refersTo,
    id?: string,
  ): Promise<{ readonly edgeId: string }> {
    const edge = this.linkSync(from, to, type, id)
    await this.flush()
    return edge
  }

  /** The unflushed half of `link`. See `addNodeSync`. */
  linkSync(
    from: string,
    to: string,
    type: Parameters<Episteme['graph']['addEdge']>[0]['type'] = EDGE.refersTo,
    id?: string,
  ): { readonly edgeId: string } {
    const edge = this.#episteme.graph.addEdge({
      id: asId<EdgeId>(id ?? `edge_${this.#episteme.log.eventCount}_${slug(from)}_${slug(to)}`),
      type,
      from: asId<NodeId>(from),
      to: asId<NodeId>(to),
    })
    return { edgeId: edge.id }
  }

  /** Every node the learner can see, for an overview of their own graph. */
  listNodes(): readonly NodeView[] {
    return this.#episteme.graph.listNodes().map((node) => this.#view(node))
  }

  /** What the human understands about one node, for a detail panel. */
  understandingOf(
    target: NodeId | string,
  ): readonly { readonly id: string; readonly level: string }[] {
    const state = this.#episteme.log.stateOf(asId<NodeId>(target), HUMAN)
    return [...state]
      .map(([id, value]) => ({ id, level: value.level ?? String(value.scalar ?? '?') }))
      .sort((left, right) => (left.id < right.id ? -1 : 1))
  }

  /** The open ends of this learner's lines of inquiry, so a surface can show where they left off. */
  openEnds(): readonly {
    readonly eventId: string
    readonly target: string
    readonly label: string
  }[] {
    return this.#episteme.log.tips(HUMAN).map((event) => ({
      eventId: event.id,
      target: event.target,
      label: this.#episteme.graph.getNode(event.target)?.label ?? event.target,
    }))
  }

  /**
   * Writes the history through the store, if there is one.
   *
   * Serialised behind a promise chain because two concurrent callers could otherwise interleave a read of
   * the log with a partial write of the file. `LocalStorageAdapter.save` is already atomic per write; this
   * keeps the *sequence* ordered too.
   */
  flush(): Promise<void> {
    const next = this.#saveChain.then(() => this.#persistNow())
    // The chain must survive a failed write without becoming permanently rejected, while the caller still
    // sees the failure.
    this.#saveChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async #persistNow(): Promise<void> {
    if (this.#store === undefined) return
    await this.#episteme.persist()
    await this.#store.save()
  }

  #view(node: GraphNode): NodeView {
    return {
      nodeId: node.id,
      label: node.label,
      type: node.type,
      tier: node.meta.tier ?? 'thought',
      tags: [...node.tags],
    }
  }
}

/** Turns the retrieval's recorded contributions into something a view can render. */
function toRankedView(context: RelevantContext): readonly RankedView[] {
  const ranked: readonly RankedEntry[] = context.ranked ?? []
  const byId = new Map(context.nodes.map((node) => [node.id, node]))

  return ranked.map((entry) => {
    const node = byId.get(entry.nodeId)
    const reasons = [...entry.contributions]
      .sort((left, right) => right.contribution - left.contribution)
      .map((contribution) => ({
        signal: contribution.signal,
        value: contribution.value,
        weight: contribution.weight,
        contribution: contribution.contribution,
        share: entry.score === 0 ? 0 : contribution.contribution / entry.score,
        explanation: explainSignal(contribution.signal, contribution.value, entry.matchedTerms),
      }))

    return {
      nodeId: entry.nodeId,
      label: node?.label ?? entry.nodeId,
      type: node?.type ?? 'unknown',
      score: entry.score,
      origin: entry.origin,
      matchedTerms: entry.matchedTerms,
      reasons,
    }
  })
}

/**
 * How one signal is being read, in the learner's terms.
 *
 * The point of showing this at all is that a relevance decision about someone's own understanding should
 * be legible to them. A bare number would be a request for trust; a sentence is something they can argue
 * with.
 */
function explainSignal(signal: string, value: number, matchedTerms: readonly string[]): string {
  switch (signal) {
    case 'semantic':
      return value === 0
        ? 'not close in meaning to your question'
        : `close in meaning to your question (${(value * 100).toFixed(0)}% similarity)`
    case 'lexical':
      return matchedTerms.length > 0
        ? `shares the words ${matchedTerms.map((term) => `"${term}"`).join(', ')}`
        : 'no words in common with your question'
    case 'graph':
      return value >= 1 ? 'is what you asked about' : 'is connected to what you asked about'
    case 'cognitive':
      return value === 0
        ? 'you have not recorded anything about it'
        : 'your own recorded understanding makes it worth resurfacing'
    case 'recency':
      return 'recently added or changed'
    default:
      return signal
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 40) || 'node'
  )
}
