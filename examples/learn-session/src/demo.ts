import {
  EventLog,
  applyDomainPacks,
  asId,
  createFixedClock,
  createGraph,
  createRegistries,
  type Actor,
  type ActorId,
  type CoreGraph,
  type DimensionId,
  type EdgeId,
  type EventId,
  type NodeId,
  type StateValue,
} from '@episteme/core'
import {
  DIMENSION,
  EDGE,
  NODE,
  learnerResponder,
  learnDomainPack,
  learnTags,
  retrieveRelevantContext,
  toAgentContext,
} from '@episteme/domain-learn'
import { MockCognitiveAgent, describeWorkspace } from '@episteme/agent'
import type { AgentResponse, AgentWorkspace } from '@episteme/agent'
import { createMemoryStorage } from '@episteme/storage-memory'

/**
 * The v0 closed loop, end to end, printed as a narrative.
 *
 * The scenario is the one the project is specified around: a learner asks why a Transformer
 * needs positional encoding, forms a first claim, refines it, and then — from that earlier,
 * cruder understanding — opens a second line of inquiry about relative position. A later
 * question about RoPE is then answered differently because the earlier understanding was
 * stored.
 *
 * Runs on a fixed clock and a scripted agent, so the output is identical on every run. That
 * matters: step 9 only means anything if the agent could not have produced its answer by luck.
 */

export interface DemoStep {
  readonly title: string
  readonly lines: readonly string[]
}

export interface DemoResult {
  readonly steps: readonly DemoStep[]
  /** The learner's understanding of the refined claim, at the end of the story. */
  readonly finalState: Readonly<Record<string, string>>
  /** The same question asked before and after understanding was recorded. */
  readonly responseWithoutState: AgentResponse
  readonly responseWithState: AgentResponse
  readonly firstClaimEventId: EventId
  readonly forkEventId: EventId
}

const CONCEPT = {
  transformer: asId<NodeId>('c_transformer'),
  selfAttention: asId<NodeId>('c_self_attention'),
  positionalEncoding: asId<NodeId>('c_positional_encoding'),
  permutationInvariance: asId<NodeId>('c_permutation_invariance'),
  rope: asId<NodeId>('c_rope'),
} as const

const QUESTION_NEW = 'Why does Transformer need positional encoding?'
const QUESTION_ORDER = "Why can't self-attention infer order itself?"
const QUESTION_ROPE = 'Then why does RoPE work?'
const QUESTION_RELATIVE = 'Could relative position solve this differently?'

const CLAIM_INDEX = asId<NodeId>('claim_index')
const CLAIM_ORDER = asId<NodeId>('claim_order')

const CLAIM_INDEX_TEXT = 'Positional encoding gives every token an index.'
const CLAIM_ORDER_TEXT = 'Self-attention alone does not encode sequence order.'

function dim(entries: readonly (readonly [string, StateValue])[]): Map<DimensionId, StateValue> {
  const map = new Map<DimensionId, StateValue>()
  for (const [key, value] of entries) map.set(asId<DimensionId>(key), value)
  return map
}

function level(value: string): StateValue {
  return { level: value }
}

function stateRecord(state: ReadonlyMap<DimensionId, StateValue>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [dimension, value] of state) {
    record[dimension] = value.level ?? String(value.scalar ?? '')
  }
  return record
}

export interface DemoWorld {
  readonly graph: CoreGraph
  readonly log: EventLog
  readonly humanId: ActorId
  readonly agentId: ActorId
}

/**
 * Builds the graph a demo or a test needs, without running the narrative.
 *
 * Exposed so a test can assemble the same world and assert on it directly, instead of
 * parsing the printed output.
 */
export function createDemoWorld(): DemoWorld {
  const clock = createFixedClock(0)
  const registries = createRegistries()
  applyDomainPacks([learnDomainPack], { registries })

  const humanId = asId<ActorId>('actor_learner')
  const agentId = asId<ActorId>('actor_scaffold')
  const human: Actor = {
    id: humanId,
    kind: 'human',
    displayName: 'Learner',
    shareByDefault: false,
    createdAt: clock.now(),
  }
  const scaffold: Actor = {
    id: agentId,
    kind: 'agent',
    displayName: 'Scaffold',
    shareByDefault: false,
    createdAt: clock.now(),
  }

  const graph = createGraph({ storage: createMemoryStorage(), registries, clock, actorId: humanId })
  graph.registerActor(human)
  graph.registerActor(scaffold)
  const log = new EventLog({ registries, clock, graph, defaultActorId: humanId })

  return { graph, log, humanId, agentId }
}

/**
 * The shared knowledge skeleton the learner explores against.
 *
 * Concepts are public and shared; nothing here belongs to any one learner. That separation is
 * what lets the same graph serve a discussion or a research view later.
 */
export function seedConcepts(world: DemoWorld): void {
  const concept = (id: NodeId, label: string, topic: string) =>
    world.graph.addNode({
      id,
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'paper:arxiv:1706.03762',
    })

  concept(CONCEPT.transformer, 'Transformer', 'transformer')
  concept(CONCEPT.selfAttention, 'Self-Attention', 'transformer')
  concept(CONCEPT.positionalEncoding, 'Positional Encoding', 'transformer')
  concept(CONCEPT.permutationInvariance, 'Permutation Invariance', 'transformer')
  concept(CONCEPT.rope, 'RoPE', 'rope')

  world.graph.addEdge({
    id: asId<EdgeId>('e_attention_refers_invariance'),
    type: EDGE.refersTo,
    from: CONCEPT.selfAttention,
    to: CONCEPT.permutationInvariance,
  })
  world.graph.addEdge({
    id: asId<EdgeId>('e_positional_refers_invariance'),
    type: EDGE.refersTo,
    from: CONCEPT.positionalEncoding,
    to: CONCEPT.permutationInvariance,
  })
  world.graph.addEdge({
    id: asId<EdgeId>('e_rope_refers_invariance'),
    type: EDGE.refersTo,
    from: CONCEPT.rope,
    to: CONCEPT.permutationInvariance,
  })
}

/** The workspace an agent may see for one question: a projection plus this actor's state. */
export function buildWorkspace(
  graph: CoreGraph,
  log: EventLog,
  actorId: ActorId,
  topic: string,
): AgentWorkspace {
  const nodes = graph.findNodes({ tags: [`topic:${topic}`] })
  const state: Record<string, StateValue> = {}
  for (const node of nodes) {
    for (const [dimension, value] of log.stateOf(node.id, actorId)) {
      state[`${node.label}#${dimension}`] = value
    }
  }
  return { actorId, nodeIds: nodes.map((node) => node.id), state }
}

/** The key shape `buildWorkspace` uses, so scripted rules can be written against it. */
export function stateKey(label: string, dimension: string): string {
  return `${label}#${dimension}`
}

/**
 * Asks one question with the retrieval layer in the loop.
 *
 * This is the shape a real application would use: retrieve what is relevant *to this learner*,
 * hand it to the agent, get an answer. Nothing here is special-cased for the demo.
 */
export async function ask(
  world: DemoWorld,
  agent: MockCognitiveAgent,
  question: string,
  options: { readonly topic?: string; readonly depth?: number } = {},
): Promise<{ response: AgentResponse; summary: string; retrieved: readonly string[] }> {
  const retrieved = retrieveRelevantContext(world.graph, world.log, question, {
    actorId: world.humanId,
    ...(options.topic === undefined ? {} : { tags: [`topic:${options.topic}`] }),
    depth: options.depth ?? 1,
  })
  const response = await agent.respond({ text: question }, toAgentContext(retrieved))
  return {
    response,
    summary: retrieved.summary,
    retrieved: retrieved.nodes.map((node) => node.label),
  }
}

export async function runDemo(): Promise<DemoResult> {
  const steps: DemoStep[] = []
  const world = createDemoWorld()
  const { graph, log, humanId } = world
  seedConcepts(world)

  const agent = new MockCognitiveAgent({ responder: learnerResponder })

  // ── 1. The question ───────────────────────────────────────────────────────
  graph.addNode({
    id: asId<NodeId>('q_positional'),
    type: NODE.question,
    label: QUESTION_NEW,
    properties: { text: QUESTION_NEW },
    tags: learnTags('transformer'),
    tier: 'thought',
    source: 'session:1',
  })
  steps.push({
    title: '1. The learner asks a question',
    lines: [
      `Question: ${QUESTION_NEW}`,
      'Shared concepts already in the graph (public, not owned by anyone):',
      ...Object.values(CONCEPT).map((id) => `  - ${graph.getNode(id)?.label ?? id}`),
    ],
  })

  // ── 2. What the agent can see before anything is understood ────────────────
  const before = await ask(world, agent, QUESTION_ROPE, { topic: 'rope' })
  steps.push({
    title: '2. First interaction — the agent has no recorded understanding',
    lines: [
      `Question: ${QUESTION_ROPE}`,
      `Retrieved: ${before.retrieved.join(', ') || '(nothing relevant)'}`,
      `Prior understanding: ${before.summary === '' ? 'nothing recorded' : before.summary}`,
      `Agent (usedContext=${before.response.usedContext}): ${before.response.text}`,
    ],
  })

  // ── 3. A first, cruder claim ──────────────────────────────────────────────
  graph.addNode({
    id: CLAIM_INDEX,
    type: NODE.claim,
    label: CLAIM_INDEX_TEXT,
    properties: { text: CLAIM_INDEX_TEXT },
    tags: learnTags('transformer'),
    tier: 'thought',
    source: 'session:1',
  })
  graph.addEdge({
    id: asId<EdgeId>('e_index_answers_question'),
    type: EDGE.answers,
    from: CLAIM_INDEX,
    to: asId<NodeId>('q_positional'),
  })
  graph.addEdge({
    id: asId<EdgeId>('e_index_refers_positional'),
    type: EDGE.refersTo,
    from: CLAIM_INDEX,
    to: CONCEPT.positionalEncoding,
  })

  const first = log.commit({
    target: CLAIM_INDEX,
    actorId: humanId,
    dimensions: dim([
      [DIMENSION.exposure, level('seen')],
      [DIMENSION.confidence, level('medium')],
      [DIMENSION.evidence, level('anecdotal')],
      [DIMENSION.source, level('self')],
    ]),
    reason: 'first attempt at an answer',
    source: 'session:1',
  })
  steps.push({
    title: '3. The learner forms a first claim',
    lines: [
      `Claim: ${CLAIM_INDEX_TEXT}`,
      `StateEvent ${first.id} → ${JSON.stringify(stateRecord(first.dimensions))}`,
    ],
  })

  const firstEventId = first.id

  // ── 4. The question that forces a better claim ────────────────────────────
  graph.addNode({
    id: asId<NodeId>('q_order'),
    type: NODE.question,
    label: QUESTION_ORDER,
    properties: { text: QUESTION_ORDER },
    tags: [...learnTags('transformer'), 'topic:rope'],
    tier: 'thought',
    source: 'session:1',
  })
  graph.addNode({
    id: CLAIM_ORDER,
    type: NODE.claim,
    label: CLAIM_ORDER_TEXT,
    properties: { text: CLAIM_ORDER_TEXT },
    // RoPE exists to answer exactly this limitation, so the claim sits under both topics.
    tags: [...learnTags('transformer'), 'topic:rope'],
    tier: 'thought',
    source: 'session:1',
  })
  graph.addEdge({
    id: asId<EdgeId>('e_order_answers_question'),
    type: EDGE.answers,
    from: CLAIM_ORDER,
    to: asId<NodeId>('q_order'),
  })
  graph.addEdge({
    id: asId<EdgeId>('e_order_refers_attention'),
    type: EDGE.refersTo,
    from: CLAIM_ORDER,
    to: CONCEPT.selfAttention,
  })
  // The older claim is not deleted: it is kept, and pointed forward at what replaced it.
  graph.addEdge({
    id: asId<EdgeId>('e_index_evolves_order'),
    type: EDGE.evolvesTo,
    from: CLAIM_INDEX,
    to: CLAIM_ORDER,
    source: 'session:1',
  })

  const second = log.commit({
    target: CLAIM_ORDER,
    actorId: humanId,
    dimensions: dim([
      [DIMENSION.exposure, level('studied')],
      [DIMENSION.confidence, level('high')],
      [DIMENSION.articulation, level('medium')],
      [DIMENSION.evidence, level('reproduced')],
      [DIMENSION.source, level('paper')],
    ]),
    reason: 'worked out why attention cannot represent order on its own',
    source: 'session:1',
  })
  steps.push({
    title: '4. Exploration produces a more precise claim',
    lines: [
      `Question: ${QUESTION_ORDER}`,
      `Claim: ${CLAIM_ORDER_TEXT}`,
      `StateEvent ${second.id} → ${JSON.stringify(stateRecord(second.dimensions))}`,
      `Lineage: "${CLAIM_INDEX_TEXT}" --evolves_to--> "${CLAIM_ORDER_TEXT}"`,
      'The earlier claim is kept. A change of mind is a new claim, never an overwrite.',
    ],
  })

  // ── 5. Fork from the *earlier* understanding ──────────────────────────────
  // Deliberately not from the tip: the interesting question ("could relative position work
  // differently?") starts from what the learner believed *before* refining it.
  const forked = log.fork({
    from: firstEventId,
    target: CLAIM_INDEX,
    actorId: humanId,
    dimensions: dim([
      [DIMENSION.confidence, level('low')],
      [DIMENSION.conflict, level('open')],
      [DIMENSION.articulation, level('low')],
    ]),
    reason: 'relative position may answer this without absolute indices',
    source: 'session:2',
  })
  steps.push({
    title: '5. A second path opens from the earlier understanding',
    lines: [
      `Forked at ${firstEventId} (the medium-confidence claim), not at the latest event`,
      `New event ${forked.event.id} on branch ${forked.branch.id}`,
      `Branch ancestry: ${log.branchAncestry(forked.branch.id).join(' → ')}`,
      `Inherited state: ${JSON.stringify(stateRecord(log.stateOf(CLAIM_INDEX, humanId)))}`,
      'The fork starts from what was understood then, so the old claim is still usable as a',
      'starting point rather than only as history.',
    ],
  })

  // ── 6. The lineage is preserved, not rewritten ────────────────────────────
  const historyIndex = log.history({ target: CLAIM_INDEX, actorId: humanId })
  steps.push({
    title: '6. Both directions remain readable',
    lines: [
      `History of "${CLAIM_INDEX_TEXT}" (${historyIndex.length} events): ${historyIndex.map((e) => e.id).join(' → ')}`,
      `Open ends for this learner: ${log.tips(humanId).length}`,
      `The revoked-free record still shows the original reasoning: "${
        log.getEvent(firstEventId)?.reason ?? ''
      }"`,
    ],
  })

  // ── 7. Inspectable history and a retraction ───────────────────────────────
  const revocation = log.revokeStateEvent(forked.event.id, {
    reason: 'reconsidered: the fork needs its own evidence first',
  })
  steps.push({
    title: '7. A recorded change can be retracted without being erased',
    lines: [
      `Retracted ${revocation.eventId} (${revocation.reason ?? 'no reason given'})`,
      `The event is still readable: ${JSON.stringify(stateRecord(log.getEvent(forked.event.id)?.dimensions ?? new Map()))}`,
      `Its effect is gone: state is now ${JSON.stringify(stateRecord(log.stateOf(CLAIM_INDEX, humanId)))}`,
      'Deleting it would erase the fact that the learner once understood this differently.',
    ],
  })

  // ── 8. A later question, with the same agent and code ─────────────────────
  const after = await ask(world, agent, QUESTION_ROPE, { topic: 'rope' })
  steps.push({
    title: '8. Later interaction — the same question, with understanding recorded',
    lines: [
      `Question: ${QUESTION_ROPE}`,
      `Retrieved for this learner: ${after.retrieved.join(', ')}`,
      `Prior understanding: ${after.summary}`,
      `Agent (usedContext=${after.response.usedContext}): ${after.response.text}`,
    ],
  })

  // ── 9. The difference is the point ────────────────────────────────────────
  const originalLine = log.history({
    target: CLAIM_INDEX,
    actorId: humanId,
    branchId: log.defaultBranchId,
  })
  const forkedLine = log.history({
    target: CLAIM_INDEX,
    actorId: humanId,
    branchId: forked.branch.id,
  })
  steps.push({
    title: '9. The same question, answered differently because the graph remembered',
    lines: [
      `without state: ${before.response.text}`,
      `with state:    ${after.response.text}`,
      `identical response? ${before.response.text === after.response.text}`,
      `Next exploration opened: ${QUESTION_RELATIVE}`,
      `The original line keeps ${originalLine.length} change(s); the forked line keeps ${forkedLine.length}.`,
      `Open lines of inquiry: ${log.tips(humanId).length}`,
      'Same question, same agent, same code — the input differed because the graph remembered.',
    ],
  })

  return {
    steps,
    finalState: stateRecord(log.stateOf(CLAIM_ORDER, humanId)),
    responseWithoutState: before.response,
    responseWithState: after.response,
    firstClaimEventId: firstEventId,
    forkEventId: forked.event.id,
  }
}

/** Renders the demo as plain text, which is what `pnpm demo` prints. */
export function formatDemo(result: DemoResult): string {
  const blocks = result.steps.map((step) => {
    const body = step.lines.map((line) => `   ${line}`).join('\n')
    return `${step.title}\n${body}`
  })
  const finalState = Object.entries(result.finalState)
    .map(([dimension, value]) => `${dimension}=${value}`)
    .join(', ')
  return [...blocks, `Final understanding of the refined claim: ${finalState}`].join('\n\n')
}

/** Kept so callers that only want a readable workspace still have one. */
export { describeWorkspace }
