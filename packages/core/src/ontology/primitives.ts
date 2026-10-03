import type { ActorId, EventId, NodeId, EdgeId } from './ids.js'

/**
 * Time is always an explicit UTC epoch millisecond value supplied by a clock.
 *
 * Episteme is event-sourced and branchable, so "when did this happen" is part of
 * the data. Reading the wall clock inside Core would make histories un-replayable.
 */
export type EpochMillis = number

/** A small seam so tests can drive history deterministically. */
export interface Clock {
  now(): EpochMillis
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

/**
 * Deterministic clock: increments by one millisecond per read.
 *
 * Used by tests and the demo so that produced histories are byte-for-byte stable.
 */
export function createFixedClock(start: EpochMillis = 0, step = 1): Clock {
  let current = start
  return {
    now: () => {
      const value = current
      current += step
      return value
    },
  }
}

export interface Timestamps {
  readonly createdAt: EpochMillis
  /** Unset while the entity is current; set when a later revision supersedes it. */
  readonly updatedAt?: EpochMillis
}

export interface Provenance {
  /** Who caused this to exist. Never inferred; always supplied by the caller. */
  readonly actorId: ActorId
  /**
   * Where the content came from, e.g. `session:abc`, `paper:arxiv:1706.03762`.
   *
   * Provenance is what separates a `Reference` from an unsourced assertion, so it
   * is carried on the entity rather than in a side table.
   */
  readonly source?: string
}

export type EntityRef =
  | { readonly kind: 'node'; readonly id: NodeId }
  | { readonly kind: 'edge'; readonly id: EdgeId }
  | { readonly kind: 'event'; readonly id: EventId }
