import {
  EventLog,
  applyDomainPacks,
  asId,
  createFixedClock,
  createGraph,
  createRegistries,
  type Actor,
  type ActorId,
  type BranchId,
  type CoreGraph,
  type DimensionId,
  type EventLogState,
  type GraphStorageAdapter,
  type NodeId,
  type PersistentEventStore,
  type Registries,
  type StateValue,
} from '@episteme/core'
import { learnDomainPack, retrieveRelevantContext, toAgentContext } from '@episteme/domain-learn'
import { MockCognitiveAgent, type AgentResponse } from '@episteme/agent'
import { createMemoryStorage } from '@episteme/storage-memory'

/**
 * A wired-up Episteme instance for tests and the demo.
 *
 * One fixture for the whole repo so that every test exercises the same composition:
 * Core graph + one storage adapter + one domain pack + one event log. If the layers stop
 * fitting together, this fixture stops working rather than each test inventing its own
 * wiring.
 */
export interface EpistemeContext {
  readonly graph: CoreGraph
  readonly log: EventLog
  readonly registries: Registries
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
  const registries = createRegistries()
  applyDomainPacks([learnDomainPack], { registries })

  const storage = createMemoryStorage()
  const clock = createFixedClock(startedAt)
  const { human, agent, humanId, agentId } = createActors(() => clock.now())

  const graph = createGraph({ storage, registries, clock, actorId: humanId })
  graph.registerActor(human)
  graph.registerActor(agent)

  const log = new EventLog({ registries, clock, graph, defaultActorId: humanId })
  const wired = createGraph({ storage, registries, state: log, clock, actorId: humanId })
  wired.registerActor(human)
  wired.registerActor(agent)

  return { graph: wired, log, registries, human, agent, humanId, agentId }
}

/**
 * Composes an instance over a durable store.
 *
 * The order matters and mirrors `createFixture`: the store is read first, then the graph is built
 * over it, and only then is the event log created — because the log validates every commit against
 * the graph, and validating against a graph that had not loaded yet would reject writes that are
 * perfectly legal.
 *
 * The log receives the *unwired* graph, exactly as `createFixture` does: validation needs nodes and
 * edges, never state, and wiring state into the validating view would make the two views mutually
 * dependent.
 */
export async function openEpisteme(
  store: PersistentEventStore & GraphStorageAdapter,
  startedAt = 0,
): Promise<EpistemeContext> {
  const registries = createRegistries()
  applyDomainPacks([learnDomainPack], { registries })

  const clock = createFixedClock(startedAt)
  const { human, agent, humanId, agentId } = createActors(() => clock.now())
  const initialState: EventLogState | undefined = await store.load()

  const graph = createGraph({ storage: store, registries, clock, actorId: humanId })
  graph.registerActor(human)
  graph.registerActor(agent)

  const log = new EventLog({
    registries,
    clock,
    graph,
    defaultActorId: humanId,
    store,
    ...(initialState === undefined ? {} : { initialState }),
  })
  const wired = createGraph({ storage: store, registries, state: log, clock, actorId: humanId })
  wired.registerActor(human)
  wired.registerActor(agent)

  return { graph: wired, log, registries, human, agent, humanId, agentId }
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
 * Shared so that a restart test measures the *same* interaction before and after, rather than two
 * subtly different ones. Deterministic by construction, which is what makes "the answer differed"
 * attributable to persisted memory.
 */
export async function askIn(
  context: EpistemeContext,
  agent: MockCognitiveAgent,
  question: string,
  options: { readonly actorId?: ActorId; readonly depth?: number } = {},
): Promise<RetrievedTurn> {
  const actorId = options.actorId ?? context.humanId
  const retrieved = retrieveRelevantContext(context.graph, context.log, question, {
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

export { MockCognitiveAgent }
