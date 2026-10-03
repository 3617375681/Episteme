import type { ActorId, NodeId, EdgeId, NodeTypeId, EdgeTypeId } from './ids.js'
import type { EpochMillis, Provenance, Timestamps } from './primitives.js'

/**
 * Structural fields shared by every graph entity.
 *
 * `priority` deserves its name: it is a *structural tie-breaker for ordering*, not
 * a score, a weight or a rank. Episteme deliberately has no place to store
 * "how good is this" — ranking belongs to an Application, and understanding is
 * never a single number (see the state model).
 */
export interface EntityBase extends Timestamps, Provenance {
  /** Free-form ordering hint. Not a judgement about quality. */
  readonly priority?: number
  /**
   * Set when the entity was retracted.
   *
   * A revoked entity is *not* deleted: it stays readable so history and audit remain
   * honest, while ordinary queries hide it. This is the model's alternative to
   * overwriting, applied to structure as well as to state.
   */
  readonly revoked?: boolean
  /** When the retraction happened, for history display. */
  readonly revokedAt?: EpochMillis
}

/** Node-local metadata. Everything domain-specific lives in `properties`. */
export interface NodeMeta {
  /** Structural role in the refinement ladder: draft → thought → reference. */
  readonly tier?: Tier
}

/**
 * The admission ladder for content.
 *
 * `draft` is raw and not part of the cognitive graph by default; `thought` is a
 * user-organized unit of understanding; `reference` is public, sourced and verified.
 */
export type Tier = 'draft' | 'thought' | 'reference'

/**
 * A graph node: the single carrier of every cognitive object.
 *
 * `properties` is intentionally open. The registered node type declares which
 * properties are required and of what shape; the graph itself stays agnostic so
 * that new domains need no Core change.
 */
export interface GraphNode<TProperties = Readonly<Record<string, unknown>>> extends EntityBase {
  readonly id: NodeId
  readonly type: NodeTypeId
  readonly label: string
  readonly properties: TProperties
  readonly tags: readonly string[]
  readonly meta: NodeMeta
}

/**
 * A directed, typed relation between two nodes.
 *
 * `confidence` here expresses the graph's confidence *that the relation holds*
 * ("does this evidence really support that claim?"). It is not the actor's
 * understanding state — that lives in StateEvents.
 */
export interface GraphEdge extends EntityBase {
  readonly id: EdgeId
  readonly type: EdgeTypeId
  readonly from: NodeId
  readonly to: NodeId
  readonly confidence?: number
}

/**
 * A view over nodes and edges.
 *
 * A projection returns a SubGraph rather than a filtered node list because edges
 * only mean something relative to the nodes they connect.
 */
export interface SubGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
}

/** Adjacency in both directions, since traversal order is a view concern. */
export interface Neighbors {
  readonly incoming: readonly GraphEdge[]
  readonly outgoing: readonly GraphEdge[]
}

export interface NodeQuery {
  readonly type?: NodeTypeId
  readonly actorId?: ActorId
  /**
   * Tag patterns, each `namespace:value`; `namespace:*` matches any value.
   *
   * Patterns are AND-ed, so `['topic:rope', 'state:active']` means both.
   */
  readonly tags?: readonly string[]
  readonly since?: EpochMillis
  readonly until?: EpochMillis
  /** Upper bound on returned nodes; omitted means no limit. */
  readonly limit?: number
  /**
   * Whether nodes at tier `draft` are included.
   *
   * Defaults to `false`: a draft is raw material, not understanding, so the ordinary
   * ways of finding nodes should not surface it.
   */
  readonly includeDrafts?: boolean
  /** Whether retracted nodes are included. Defaults to `false`. */
  readonly includeRevoked?: boolean
}

/** Whether a tag matches a pattern of the form `namespace:value` or `namespace:*`. */
function matchesTagPattern(tags: readonly string[], pattern: string): boolean {
  const separator = pattern.indexOf(':')
  if (separator < 0) return tags.includes(pattern)

  const namespace = pattern.slice(0, separator)
  const wanted = pattern.slice(separator + 1)
  const prefix = `${namespace}:`
  return tags.some((tag) => {
    if (!tag.startsWith(prefix)) return false
    return wanted === '*' || tag.slice(prefix.length) === wanted
  })
}

/**
 * Applies a node query.
 *
 * Kept here, as one function, rather than reimplemented per adapter: "which nodes does
 * this query select" is a graph guarantee, and two implementations of it would drift.
 * A backend is free to *index* this, but the semantics have exactly one definition.
 */
export function queryNodes(
  nodes: readonly GraphNode[],
  query: NodeQuery = {},
): readonly GraphNode[] {
  const patterns = query.tags ?? []
  const selected: GraphNode[] = []

  for (const node of nodes) {
    if (node.revoked === true && query.includeRevoked !== true) continue
    if (query.includeDrafts !== true && node.meta.tier === 'draft') continue
    if (query.type !== undefined && node.type !== query.type) continue
    if (query.actorId !== undefined && node.actorId !== query.actorId) continue
    if (query.since !== undefined && node.createdAt < query.since) continue
    if (query.until !== undefined && node.createdAt > query.until) continue
    if (!patterns.every((pattern) => matchesTagPattern(node.tags, pattern))) continue

    selected.push(node)
    if (query.limit !== undefined && selected.length >= query.limit) break
  }

  return selected
}
