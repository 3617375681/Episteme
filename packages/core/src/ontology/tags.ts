/**
 * Tags name the vocabularies a view is built from.
 *
 * A tag is a namespaced string — `scene:learn`, `topic:transformer`, `state:verified` —
 * and the namespace must be registered before use. Namespacing is what allows unrelated
 * vocabularies to coexist on one graph instead of colliding in a flat string space.
 */
export type Tag = string

/** The namespaces Episteme Core itself relies on. Domains register their own. */
export const CORE_TAG_NAMESPACES = {
  /** Which product surface a node belongs to. */
  scene: 'scene',
  /** Which actor or actor class a node is scoped to. */
  actor: 'actor',
  /** Subject matter, used to build topical views. */
  topic: 'topic',
  /** Lifecycle of the content itself, e.g. `state:verified`. */
  state: 'state',
  /** Platform-level concerns, e.g. `system:seed`. */
  system: 'system',
} as const

export type CoreTagNamespace = (typeof CORE_TAG_NAMESPACES)[keyof typeof CORE_TAG_NAMESPACES]

export function tag(namespace: string, value: string): Tag {
  return `${namespace}:${value}`
}

export function sceneTag(scene: string): Tag {
  return tag(CORE_TAG_NAMESPACES.scene, scene)
}

export function topicTag(topic: string): Tag {
  return tag(CORE_TAG_NAMESPACES.topic, topic)
}

export function stateTag(state: string): Tag {
  return tag(CORE_TAG_NAMESPACES.state, state)
}

export function actorTag(actorId: string): Tag {
  return tag(CORE_TAG_NAMESPACES.actor, actorId)
}
