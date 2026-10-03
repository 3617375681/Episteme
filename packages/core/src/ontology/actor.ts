import type { ActorId } from './ids.js'
import type { EpochMillis } from './primitives.js'

/**
 * An Actor is any subject that can hold or change cognitive state.
 *
 * Human, community and agent actors share one representation on purpose: an agent's
 * suggestion and a human's belief are the same *shape* of thing, differing in
 * authority. That difference is expressed by `authority`, never by a separate model.
 */
export type ActorKind = 'human' | 'community' | 'agent'

/**
 * How far an actor's assertion travels.
 *
 * - `author`     — the actor owns this as their own understanding.
 * - `suggested`  — proposed by an agent or another actor; requires confirmation.
 * - `endorsed`   — the community adopted it as reference knowledge.
 * - `institutional` — backed by an institution; the strongest, still revocable.
 */
export type Authority = 'author' | 'suggested' | 'endorsed' | 'institutional'

export interface Actor {
  readonly id: ActorId
  readonly kind: ActorKind
  readonly displayName: string
  /**
   * Whether this actor's personal state is exposed by default.
   *
   * Personal cognitive history is sensitive, so the default is private and
   * contribution is an explicit opt-in (see the Privacy invariant).
   */
  readonly shareByDefault: boolean
  readonly createdAt: EpochMillis
}

export interface ActorDraft {
  readonly id: ActorId
  readonly kind: ActorKind
  readonly displayName: string
  readonly shareByDefault?: boolean
}
