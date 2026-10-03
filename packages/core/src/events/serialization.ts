import type { StateEvent, StateValue } from '../ontology/state.js'
import type { ActorId, BranchId, EventId, NodeId } from '../ontology/ids.js'

/**
 * The serialized form of a state event.
 *
 * Defined explicitly rather than inferred from the entity, so that the durable shape is a
 * deliberate contract. Two details are load-bearing:
 *
 * - `dimensions` is an **array of pairs**. A `Map` does not survive `JSON.stringify`, and writing
 *   `{}` for every event's dimensions would lose the entire cognitive record while looking like a
 *   successful save.
 * - optional fields are omitted when unset, matching `exactOptionalPropertyTypes` in memory, so a
 *   reader can still tell "not stated" from "stated as empty".
 *
 * Nothing derived is included: no reduced state, no index, no cache. A durable file holds facts,
 * and an index that had to be trusted would be indistinguishable from corrupt history.
 */
export interface SerializedStateEvent {
  readonly id: string
  readonly branchId: string
  readonly target: string
  readonly actorId: string
  readonly dimensions: readonly (readonly [string, StateValue])[]
  readonly createdAt: number
  readonly updatedAt?: number
  readonly parent?: string
  readonly forkedFrom?: string
  readonly reason?: string
  readonly source?: string
}

export function toSerializedEvent(event: StateEvent): SerializedStateEvent {
  return {
    id: event.id,
    branchId: event.branchId,
    target: event.target,
    actorId: event.actorId,
    dimensions: [...event.dimensions.entries()].map(([dimension, value]) => [
      dimension,
      { ...value },
    ]),
    createdAt: event.createdAt,
    ...(event.updatedAt === undefined ? {} : { updatedAt: event.updatedAt }),
    ...(event.parent === undefined ? {} : { parent: event.parent }),
    ...(event.forkedFrom === undefined ? {} : { forkedFrom: event.forkedFrom }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.source === undefined ? {} : { source: event.source }),
  }
}

/**
 * Rebuilds an event from its serialized form.
 *
 * Every field is assigned explicitly rather than spread, because a spread would carry the
 * serialized `string` ids straight through and defeat `exactOptionalPropertyTypes`: an absent
 * `parent` would become an explicit `undefined` and the result would not be a valid `StateEvent`.
 *
 * Malformed input throws instead of degrading. A `dimensions` that is not an array of pairs would
 * otherwise yield an event that appears to record nothing, which is worse than a refusal: it looks
 * like a person who never understood anything rather than like a broken file.
 */
export function fromSerializedEvent(serialized: SerializedStateEvent): StateEvent {
  if (!Array.isArray(serialized.dimensions)) {
    throw new TypeError(
      `state event "${serialized.id}" has no readable dimensions; the persisted record is malformed`,
    )
  }

  const dimensions = new Map(
    serialized.dimensions.map(([dimension, value]) => [
      dimension as StateEvent['dimensions'] extends ReadonlyMap<infer K, unknown> ? K : never,
      Object.freeze({ ...value }),
    ]),
  )

  const event: StateEvent = Object.freeze({
    id: serialized.id as EventId,
    branchId: serialized.branchId as BranchId,
    target: serialized.target as NodeId,
    actorId: serialized.actorId as ActorId,
    dimensions,
    createdAt: serialized.createdAt,
    ...(serialized.updatedAt === undefined ? {} : { updatedAt: serialized.updatedAt }),
    ...(serialized.parent === undefined ? {} : { parent: serialized.parent as EventId }),
    ...(serialized.forkedFrom === undefined
      ? {}
      : { forkedFrom: serialized.forkedFrom as EventId }),
    ...(serialized.reason === undefined ? {} : { reason: serialized.reason }),
    ...(serialized.source === undefined ? {} : { source: serialized.source }),
  })
  return event
}
