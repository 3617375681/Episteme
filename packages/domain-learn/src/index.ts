import { asId, defineDomainPack, reject, topicTag, sceneTag, stateTag } from '@episteme/core'
import type {
  DimensionId,
  DomainPack,
  EdgeTypeDefinition,
  EdgeTypeId,
  GraphMutation,
  GuardContext,
  GuardVerdict,
  NodeId,
  NodeTypeId,
  NodeTypeDefinition,
} from '@episteme/core'

/**
 * The Learn domain.
 *
 * Learn is Episteme's first scene, not its ontology. Everything here is additive
 * vocabulary registered into Core — the shared node types (`concept`, `question`,
 * `claim`) are the same objects the Forum scene will read, so a Thought written while
 * learning can be contributed to a discussion without conversion.
 */

// ── Tag namespaces this pack relies on ───────────────────────────────────────
export const LEARN_SCENE = 'learn'

// ── Node types ───────────────────────────────────────────────────────────────

export const NODE = {
  concept: asId<NodeTypeId>('concept'),
  question: asId<NodeTypeId>('question'),
  claim: asId<NodeTypeId>('claim'),
  evidence: asId<NodeTypeId>('evidence'),
  thought: asId<NodeTypeId>('thought'),
  synthesis: asId<NodeTypeId>('synthesis'),
} as const

const nodeTypes: readonly NodeTypeDefinition[] = [
  {
    id: NODE.concept,
    label: 'Concept',
    description:
      'A stable element of the shared knowledge skeleton: Transformer, Self-Attention, RoPE. Concepts are normally public.',
    requiredProperties: ['text'],
    defaultTier: 'reference',
  },
  {
    id: NODE.question,
    label: 'Question',
    description: 'A question worth exploring. The main entrance to an exploration path.',
    requiredProperties: ['text'],
    defaultTier: 'thought',
  },
  {
    id: NODE.claim,
    label: 'Claim',
    description:
      'A statement the user currently holds, e.g. "self-attention cannot encode order by itself". Claims are the primary unit of understanding and are private by default.',
    requiredProperties: ['text'],
    defaultTier: 'thought',
  },
  {
    id: NODE.evidence,
    label: 'Evidence',
    description:
      'Something that supports or contradicts a claim: an experiment, a paper, an example, a derivation, a proof or an observation.',
    requiredProperties: ['kind', 'text'],
    defaultTier: 'thought',
  },
  {
    id: NODE.thought,
    label: 'Thought',
    description:
      'A unit of understanding the user organized deliberately. A raw AI transcript is never a Thought.',
    requiredProperties: ['text', 'anchors'],
    defaultTier: 'thought',
  },
  {
    id: NODE.synthesis,
    label: 'Synthesis',
    description: 'A combination of several thoughts, claims or branches into one position.',
    requiredProperties: ['text', 'anchors'],
    defaultTier: 'thought',
  },
]

// ── Edge types ───────────────────────────────────────────────────────────────

export const EDGE = {
  refersTo: asId<EdgeTypeId>('refers_to'),
  answers: asId<EdgeTypeId>('answers'),
  supports: asId<EdgeTypeId>('supports'),
  contradicts: asId<EdgeTypeId>('contradicts'),
  prerequisite: asId<EdgeTypeId>('prerequisite'),
  contains: asId<EdgeTypeId>('contains'),
  derivedFrom: asId<EdgeTypeId>('derived_from'),
  organizedFrom: asId<EdgeTypeId>('organized_from'),
  synthesizes: asId<EdgeTypeId>('synthesizes'),
  authoredBy: asId<EdgeTypeId>('authored_by'),
  taggedWith: asId<EdgeTypeId>('tagged_with'),
  evolvesTo: asId<EdgeTypeId>('evolves_to'),
  forksFrom: asId<EdgeTypeId>('forks_from'),
  sameAs: asId<EdgeTypeId>('same_as'),
  exemplifies: asId<EdgeTypeId>('exemplifies'),
} as const

/**
 * Core edge vocabulary.
 *
 * Declared with endpoint constraints only where the constraint is genuinely part of the
 * meaning — `supports` must point at a claim, `organized_from` must point at a draft-tier
 * node. Over-constraining here would block legitimate domain reuse later.
 */
const edgeTypes: readonly EdgeTypeDefinition[] = [
  {
    id: EDGE.refersTo,
    label: 'refers to',
    category: 'epistemic',
    description: 'This node is about that concept or question.',
    to: [NODE.concept, NODE.question],
  },
  {
    id: EDGE.answers,
    label: 'answers',
    category: 'epistemic',
    description: 'This node is an answer to that question.',
    from: [NODE.claim, NODE.evidence, NODE.thought, NODE.synthesis],
    to: [NODE.question],
  },
  {
    id: EDGE.supports,
    label: 'supports',
    category: 'epistemic',
    description: 'This evidence or reasoning supports that claim.',
    from: [NODE.evidence, NODE.thought, NODE.synthesis, NODE.claim],
    to: [NODE.claim],
  },
  {
    id: EDGE.contradicts,
    label: 'contradicts',
    category: 'epistemic',
    description:
      'Two claims are in conflict. Episteme preserves this structure instead of letting a model pick a winner.',
    from: [NODE.evidence, NODE.thought, NODE.synthesis, NODE.claim],
    to: [NODE.claim],
  },
  {
    id: EDGE.prerequisite,
    label: 'prerequisite',
    category: 'epistemic',
    description: 'The target concept should be understood before this one.',
    from: [NODE.concept],
    to: [NODE.concept],
  },
  {
    id: EDGE.contains,
    label: 'contains',
    category: 'structural',
    description: 'Structural containment, e.g. a question that contains sub-questions.',
  },
  {
    id: EDGE.derivedFrom,
    label: 'derived from',
    category: 'provenance',
    description: 'This node was derived from that node or artifact.',
  },
  {
    id: EDGE.organizedFrom,
    label: 'organized from',
    category: 'provenance',
    description:
      'This thought was organized out of that draft. Drafts enter the graph only through this move.',
  },
  {
    id: EDGE.synthesizes,
    label: 'synthesizes',
    category: 'epistemic',
    description: 'This synthesis combines those thoughts or claims.',
    from: [NODE.synthesis],
  },
  {
    id: EDGE.authoredBy,
    label: 'authored by',
    category: 'provenance',
    description: 'Authored by an actor, human or agent.',
  },
  {
    id: EDGE.taggedWith,
    label: 'tagged with',
    category: 'structural',
    description: 'Carries this tag.',
  },
  {
    id: EDGE.evolvesTo,
    label: 'evolves to',
    category: 'structural',
    description:
      'A later revision of the same idea. History is never overwritten; it points forward.',
  },
  {
    id: EDGE.forksFrom,
    label: 'forks from',
    category: 'structural',
    description: 'A second exploration path starting from the same earlier understanding.',
  },
  {
    id: EDGE.sameAs,
    label: 'same as',
    category: 'identity',
    description: 'Two nodes denote the same thing. Merging is never automatic.',
  },
  {
    id: EDGE.exemplifies,
    label: 'exemplifies',
    category: 'epistemic',
    description: 'This node is an instance or example of that concept.',
  },
]

// ── State dimensions ─────────────────────────────────────────────────────────

export const DIMENSION = {
  exposure: asId<DimensionId>('exposure'),
  confidence: asId<DimensionId>('confidence'),
  evidence: asId<DimensionId>('evidence'),
  articulation: asId<DimensionId>('articulation'),
  transfer: asId<DimensionId>('transfer'),
  conflict: asId<DimensionId>('conflict'),
  source: asId<DimensionId>('source'),
} as const

const ORDINAL_LOW_MEDIUM_HIGH = ['low', 'medium', 'high'] as const

/**
 * The axes of understanding Learn surfaces.
 *
 * There is deliberately no single `mastery` number: a learner can be confident and
 * unable to articulate, or fluent and full of unresolved conflict, and collapsing that
 * into one scalar would destroy exactly the information the system exists to keep.
 */
const stateDimensions = [
  {
    id: DIMENSION.exposure,
    label: 'Exposure',
    kind: 'ordinal' as const,
    ordered: true,
    levels: ['none', 'seen', 'studied', 'worked'],
    description: 'How much contact the learner has had with this.',
  },
  {
    id: DIMENSION.confidence,
    label: 'Confidence',
    kind: 'ordinal' as const,
    ordered: true,
    levels: ORDINAL_LOW_MEDIUM_HIGH,
    description: 'How strongly the learner currently holds this.',
  },
  {
    id: DIMENSION.evidence,
    label: 'Evidence',
    kind: 'ordinal' as const,
    ordered: true,
    levels: ['none', 'anecdotal', 'reproduced', 'proven'],
    description: 'The strength of evidence the learner can actually cite.',
  },
  {
    id: DIMENSION.articulation,
    label: 'Articulation',
    kind: 'ordinal' as const,
    ordered: true,
    levels: ORDINAL_LOW_MEDIUM_HIGH,
    description: 'How well the learner can state it in their own words.',
  },
  {
    id: DIMENSION.transfer,
    label: 'Transfer',
    kind: 'ordinal' as const,
    ordered: true,
    levels: ORDINAL_LOW_MEDIUM_HIGH,
    description: 'Whether the learner can apply it in a new situation.',
  },
  {
    id: DIMENSION.conflict,
    label: 'Conflict',
    kind: 'ordinal' as const,
    ordered: false,
    levels: ['none', 'suspected', 'open', 'resolved'],
    description: 'Whether this understanding clashes with another and how that stands.',
  },
  {
    id: DIMENSION.source,
    label: 'Source',
    kind: 'categorical' as const,
    levels: ['self', 'agent', 'paper', 'discussion', 'course'],
    description: 'Where the learner got this from. Drives the private-by-default rule.',
  },
]

// ── Guards ───────────────────────────────────────────────────────────────────

/** Property names Learn uses to point a node at the nodes it is about. */
const ANCHOR_PROPERTY = 'anchors'

/**
 * Node types that must be anchored and sourced.
 *
 * A `claim` is an assertion the learner holds and is grounded later by `supports` and
 * `contradicts` edges, so demanding an anchor up front would block the ordinary case of
 * forming a position before finding evidence for it. A `thought` or `synthesis`, by
 * contrast, *is* the act of organizing existing material, so it must name what it was
 * organized from and where it came from. This gate is why a raw draft can never be
 * promoted into understanding by accident.
 */
const ANCHORED_TYPES: readonly string[] = [NODE.thought, NODE.synthesis]

export const thoughtRequiresSourceGuard = {
  name: 'learn/thought-requires-source',
  description:
    'A thought or synthesis must carry a source and at least one anchor node; a draft can never be promoted by accident.',
  appliesTo: ['node.add'] as const,
  check(mutation: GraphMutation, _context: GuardContext): GuardVerdict {
    if (mutation.kind !== 'node.add') return { ok: true }
    const { node } = mutation
    if (!ANCHORED_TYPES.includes(node.type)) return { ok: true }

    const anchors = node.properties[ANCHOR_PROPERTY]
    if (!Array.isArray(anchors) || anchors.length === 0) {
      return reject(
        `${node.type} must reference at least one anchor node; organize a source first`,
        {
          nodeType: node.type,
          nodeId: node.id,
          property: ANCHOR_PROPERTY,
        },
      )
    }
    if (node.source === undefined || node.source.trim() === '') {
      return reject(`${node.type} must carry a source so its origin stays traceable`, {
        nodeType: node.type,
        nodeId: node.id,
      })
    }
    return { ok: true }
  },
}

/**
 * Anchors must point at nodes that exist.
 *
 * Referential integrity for anchors cannot live in Core, because "anchors" is Learn's
 * vocabulary. Registering it as a guard is what lets the domain enforce a real
 * constraint without Core learning the word.
 */
export const anchorMustExistGuard = {
  name: 'learn/anchors-must-exist',
  description: 'Every node listed in "anchors" must already exist in the graph.',
  appliesTo: ['node.add'] as const,
  check(mutation: GraphMutation, context: GuardContext): GuardVerdict {
    if (mutation.kind !== 'node.add') return { ok: true }
    const anchors = mutation.node.properties[ANCHOR_PROPERTY]
    if (!Array.isArray(anchors)) return { ok: true }

    const missing: string[] = []
    const resolving = new Set<string>()
    for (const anchor of anchors) {
      if (typeof anchor !== 'string') {
        return reject('every anchor must be a node id', { anchor: String(anchor) })
      }
      // A node may anchor itself: a Thought written directly as a thought rather than
      // promoted from a draft is its own source of truth for the exploration.
      if (anchor === mutation.node.id) continue
      resolving.add(anchor)
    }

    for (const anchor of resolving) {
      if (context.graph.getNode(anchor) === undefined) missing.push(anchor)
    }
    if (missing.length > 0) {
      return reject(`anchor node(s) not found: ${missing.join(', ')}`, { missing })
    }
    return { ok: true }
  },
}

// ── The pack ─────────────────────────────────────────────────────────────────

/**
 * The Learn domain pack.
 *
 * Applying it to a Core graph adds only vocabulary and two guards. Core is untouched,
 * which is the property that lets Forum and Research reuse the same nodes.
 */
export const learnDomainPack: DomainPack = defineDomainPack('learn', {
  tagNamespaces: [
    { namespace: 'scene', label: 'Scene', description: 'Which product surface this belongs to.' },
    { namespace: 'topic', label: 'Topic', description: 'Subject matter for topical views.' },
    { namespace: 'state', label: 'State', description: 'Lifecycle of the content itself.' },
    { namespace: 'actor', label: 'Actor', description: 'Scoping by actor.' },
    { namespace: 'system', label: 'System', description: 'Platform-level markers.' },
  ],
  nodeTypes,
  edgeTypes,
  stateDimensions,
  guards: [thoughtRequiresSourceGuard, anchorMustExistGuard],
})

/** Tags that place a node in the Learn scene under a topic. */
export function learnTags(topic: string): string[] {
  return [sceneTag(LEARN_SCENE), topicTag(topic), stateTag('active')]
}

/** Reads the anchors of a node, tolerating nodes that have none. */
export function anchorsOf(properties: Readonly<Record<string, unknown>>): readonly NodeId[] {
  const anchors = properties[ANCHOR_PROPERTY]
  if (!Array.isArray(anchors)) return []
  return anchors.filter((value): value is NodeId => typeof value === 'string')
}

export {
  nodeTypes as learnNodeTypes,
  edgeTypes as learnEdgeTypes,
  stateDimensions as learnStateDimensions,
}

// ── Learner-level context retrieval ─────────────────────────────────────────
export {
  retrieveRelevantContext,
  retrieveWith,
  settledUnderstanding,
  hasOpenConflict,
  summarise,
  contextSummary,
  learnerResponder,
  toAgentContext,
} from './context.js'
export type {
  RelevantContext,
  KnownUnderstanding,
  RankedEntry,
  RetrieveContextOptions,
} from './context.js'

// ── Retrieval strategy: the seam a different relevance model plugs into ─────
export {
  LexicalGraphRetriever,
  EmbeddingRetriever,
  HybridRetriever,
  DEFAULT_HYBRID_WEIGHTS,
  lexicalRetriever,
  embeddingRetriever,
  hybridRetriever,
  textOfNode,
  cognitiveValue,
} from './retriever.js'
export type {
  Retriever,
  RetrieveQuery,
  RankSignal,
  HybridWeights,
  SignalContribution,
  ScoredCandidate,
} from './retriever.js'
