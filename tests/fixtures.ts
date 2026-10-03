import {
  asId,
  createFixedClock,
  type Actor,
  type ActorId,
  type BranchId,
  type CoreGraph,
  type DimensionId,
  type EventLog,
  type GraphStorageAdapter,
  type NodeId,
  type PersistentEventStore,
  type Registries,
  type StateValue,
} from '@episteme/core'
import {
  compose,
  composeDeterministic,
  openEpisteme as openViaSdk,
  type Episteme,
} from '@episteme/sdk'
import { retrieveRelevantContext, toAgentContext } from '@episteme/domain-learn'
import { MockCognitiveAgent, type AgentResponse } from '@episteme/agent'

/**
 * A wired-up Episteme instance for tests.
 *
 * Composition now lives in `@episteme/sdk`, so this file is a thin adapter rather than a second
 * implementation: if the layers stop fitting together, the SDK is what fails and the tests inherit it.
 * The named actors are kept here because the existing suites address them by name.
 */
export type EpistemeContext = Episteme & {
  readonly human: Actor
  readonly agent: Actor
  readonly humanId: ActorId
  readonly agentId: ActorId
}

/** The actors every composition needs, so their ids and shapes cannot drift between fixtures. */
export function createActors(now: () => number): {
  human: Actor
  agent: Actor
  humanId: ActorId
  agentId: ActorId
} {
  const humanId = asId<ActorId>('actor_human')
  const agentId = asId<ActorId>('actor_agent')
  return {
    humanId,
    agentId,
    human: {
      id: humanId,
      kind: 'human',
      displayName: 'Learner',
      shareByDefault: false,
      createdAt: now(),
    },
    agent: {
      id: agentId,
      kind: 'agent',
      displayName: 'Scaffold',
      shareByDefault: false,
      createdAt: now(),
    },
  }
}

export function createFixture(startedAt = 0): EpistemeContext {
  const { human, agent, humanId, agentId } = createActors(() => startedAt)
  const episteme = composeDeterministic(startedAt, { actors: [human, agent], actorId: humanId })
  return { ...episteme, human, agent, humanId, agentId }
}

/**
 * Composes an instance over a durable store.
 *
 * The ordering rule — read the store, then build the graph, then the event log — lives in the SDK,
 * because getting it wrong is not a type error: a log validating against a graph that had not loaded
 * would reject writes that are perfectly legal.
 */
export async function openEpisteme(
  store: PersistentEventStore & GraphStorageAdapter,
  startedAt = 0,
): Promise<EpistemeContext> {
  const { human, agent, humanId, agentId } = createActors(() => startedAt)
  const episteme = await openViaSdk(store, {
    clock: createFixedClock(startedAt),
    actors: [human, agent],
    actorId: humanId,
  })
  return { ...episteme, human, agent, humanId, agentId }
}

/** Builds a dimension map, requiring at least one entry so no empty event slips through. */
export function dimensions(
  first: readonly [string, StateValue],
  ...rest: readonly (readonly [string, StateValue])[]
): ReadonlyMap<DimensionId, StateValue> {
  const map = new Map<DimensionId, StateValue>()
  for (const [key, value] of [first, ...rest]) {
    map.set(asId<DimensionId>(key), value)
  }
  return map
}

export function level(value: string): StateValue {
  return { level: value }
}

/** Reads one state dimension for a node, or `undefined` when unrecorded. */
export function readLevel(
  context: EpistemeContext,
  target: string,
  dimension: string,
): string | undefined {
  const state = context.log.stateOf(asId<NodeId>(target), context.humanId)
  return state.get(asId<DimensionId>(dimension))?.level
}

export interface RetrievedTurn {
  readonly response: AgentResponse
  readonly summary: string
  readonly display: string
  readonly matchedNodeIds: readonly string[]
  readonly branchId: BranchId
}

/**
 * One interaction: retrieve what this actor understands, then answer from it.
 *
 * Shared so a restart test measures the *same* interaction before and after, rather than two subtly
 * different ones. Deterministic by construction, which is what makes "the answer differed"
 * attributable to persisted memory.
 */
export async function askIn(
  context: EpistemeContext,
  agent: MockCognitiveAgent,
  question: string,
  options: { readonly actorId?: ActorId; readonly depth?: number } = {},
): Promise<RetrievedTurn> {
  const actorId = options.actorId ?? context.humanId
  const retrieved = await retrieveRelevantContext(context.graph, context.log, question, {
    actorId,
    depth: options.depth ?? 1,
  })
  const response = await agent.respond({ text: question }, toAgentContext(retrieved))
  return {
    response,
    summary: retrieved.summary,
    display: retrieved.summary === '' ? 'nothing is recorded about this yet' : retrieved.summary,
    matchedNodeIds: retrieved.nodes.map((node) => node.id),
    branchId: context.log.currentBranch(actorId).id,
  }
}

export { compose, MockCognitiveAgent }
export type { CoreGraph, EventLog, Registries }
