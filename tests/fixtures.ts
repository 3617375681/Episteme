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
  type NodeId,
  type Registries,
  type StateValue,
} from '@episteme/core'
import { learnDomainPack } from '@episteme/domain-learn'
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

export function createFixture(startedAt = 0): EpistemeContext {
  const registries = createRegistries()
  applyDomainPacks([learnDomainPack], { registries })

  const storage = createMemoryStorage()
  const clock = createFixedClock(startedAt)

  const humanId = asId<ActorId>('actor_human')
  const agentId = asId<ActorId>('actor_agent')

  const graph = createGraph({ storage, registries, clock, actorId: humanId })

  const human: Actor = {
    id: humanId,
    kind: 'human',
    displayName: 'Learner',
    shareByDefault: false,
    createdAt: clock.now(),
  }
  const agent: Actor = {
    id: agentId,
    kind: 'agent',
    displayName: 'Scaffold',
    shareByDefault: false,
    createdAt: clock.now(),
  }
  graph.registerActor(human)
  graph.registerActor(agent)

  const log = new EventLog({ registries, clock, graph, defaultActorId: humanId })
  const wired = createGraph({ storage, registries, state: log, clock, actorId: humanId })
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
