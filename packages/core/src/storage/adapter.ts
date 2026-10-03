import type { GraphEdge, GraphNode } from '../ontology/resources.js'

/**
 * Read side of the graph.
 *
 * Storage must be replaceable (in-memory now; SQLite, Postgres or a graph database
 * later), so Core depends on this interface and never on a concrete database.
 * There is deliberately no write method here: all mutation flows through
 * `GraphMutationPort`, which is what makes guards non-bypassable.
 */
export interface GraphReadPort {
  getNode(id: string): GraphNode | undefined
  getEdge(id: string): GraphEdge | undefined
  /**
   * Nodes, retracted ones excluded by default.
   *
   * `includeRevoked` exists so a history or audit view can still reach a retraction without
   * the ordinary read having to think about it. `getNode` always returns whatever is stored,
   * which is how the record survives its own retraction.
   */
  listNodes(options?: { readonly includeRevoked?: boolean }): readonly GraphNode[]
  listEdges(options?: { readonly includeRevoked?: boolean }): readonly GraphEdge[]
  /** All edges touching the node, in both directions. */
  edgesOf(nodeId: string): readonly GraphEdge[]
}

/**
 * Write side of the graph.
 *
 * The port is intentionally low-level and unguarded; enforcement lives in the graph
 * layer so that a single code path is authoritative for every mutation. Adapters are
 * expected to overwrite by id and to return the stored entity.
 */
export interface GraphMutationPort {
  putNode(node: GraphNode): GraphNode
  putEdge(edge: GraphEdge): GraphEdge
  deleteNode(id: string): boolean
  deleteEdge(id: string): boolean
  /**
   * Marks an entity retracted without removing it.
   *
   * A revoke is the honest alternative to deletion: the record stays readable for history
   * and audit, while ordinary queries hide it. Physical deletion is reserved for privacy
   * and legal erasure and is deliberately not part of this port.
   */
  revokeNode(id: string): boolean
  revokeEdge(id: string): boolean
}

/**
 * A replaceable persistence backend for the graph.
 *
 * One interface for reads and writes keeps a single implementation per backend; the
 * graph layer narrows it to the side it needs.
 */
export interface GraphStorageAdapter extends GraphReadPort, GraphMutationPort {
  readonly name: string
}
