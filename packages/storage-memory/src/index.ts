import type {
  GraphEdge,
  GraphMutationPort,
  GraphNode,
  GraphReadPort,
  GraphStorageAdapter,
} from '@episteme/core'

/**
 * In-memory storage.
 *
 * v0 deliberately starts here rather than with a graph database: the project's
 * question is how understanding evolves, not how to operate infrastructure. The
 * adapter keeps adjacency indexed because traversal is the hot path for projection,
 * while remaining a single small class that any backend can replace.
 */
export class MemoryGraphStorage implements GraphStorageAdapter {
  readonly name = 'memory'

  readonly #nodes = new Map<string, GraphNode>()
  readonly #edges = new Map<string, GraphEdge>()
  readonly #outgoing = new Map<string, Set<string>>()
  readonly #incoming = new Map<string, Set<string>>()

  getNode(id: string): GraphNode | undefined {
    return this.#nodes.get(id)
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.#edges.get(id)
  }

  /**
   * Nodes, retracted ones excluded by default.
   *
   * Draft-tier filtering is deliberately *not* done here: which nodes a query selects is a
   * graph guarantee with one definition in Core, and duplicating it per adapter is how two
   * answers to the same question start disagreeing. Retraction is different — it is a
   * property of what is stored, not of how it is queried.
   */
  listNodes(options?: { readonly includeRevoked?: boolean }): readonly GraphNode[] {
    const nodes = [...this.#nodes.values()]
    return options?.includeRevoked === true ? nodes : nodes.filter((node) => node.revoked !== true)
  }

  listEdges(options?: { readonly includeRevoked?: boolean }): readonly GraphEdge[] {
    const edges = [...this.#edges.values()]
    return options?.includeRevoked === true ? edges : edges.filter((edge) => edge.revoked !== true)
  }

  edgesOf(nodeId: string): readonly GraphEdge[] {
    const ids = new Set<string>([
      ...(this.#outgoing.get(nodeId) ?? []),
      ...(this.#incoming.get(nodeId) ?? []),
    ])
    const edges: GraphEdge[] = []
    for (const id of ids) {
      const edge = this.#edges.get(id)
      if (edge !== undefined) edges.push(edge)
    }
    return edges
  }

  putNode(node: GraphNode): GraphNode {
    this.#nodes.set(node.id, node)
    return node
  }

  putEdge(edge: GraphEdge): GraphEdge {
    // An edge id is immutable in its endpoints, so replacing one must first release
    // the old adjacency entries; otherwise a stale neighbour would survive the write.
    const previous = this.#edges.get(edge.id)
    if (previous !== undefined) this.#unindex(previous)

    this.#edges.set(edge.id, edge)
    this.#index(edge)
    return edge
  }

  deleteNode(id: string): boolean {
    return this.#nodes.delete(id)
  }

  deleteEdge(id: string): boolean {
    const edge = this.#edges.get(id)
    if (edge === undefined) return false
    this.#edges.delete(id)
    this.#unindex(edge)
    return true
  }

  revokeNode(id: string): boolean {
    const node = this.#nodes.get(id)
    if (node === undefined || node.revoked === true) return false
    this.#nodes.set(id, { ...node, revoked: true })
    return true
  }

  revokeEdge(id: string): boolean {
    const edge = this.#edges.get(id)
    if (edge === undefined || edge.revoked === true) return false
    this.#edges.set(id, { ...edge, revoked: true })
    return true
  }

  #index(edge: GraphEdge): void {
    addTo(this.#outgoing, edge.from, edge.id)
    addTo(this.#incoming, edge.to, edge.id)
  }

  #unindex(edge: GraphEdge): void {
    removeFrom(this.#outgoing, edge.from, edge.id)
    removeFrom(this.#incoming, edge.to, edge.id)
  }
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = index.get(key)
  if (bucket === undefined) {
    index.set(key, new Set([value]))
    return
  }
  bucket.add(value)
}

function removeFrom(index: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = index.get(key)
  if (bucket === undefined) return
  bucket.delete(value)
  if (bucket.size === 0) index.delete(key)
}

export function createMemoryStorage(): GraphStorageAdapter {
  return new MemoryGraphStorage()
}

// Re-exported so a caller can name the port types without also depending on Core.
export type { GraphReadPort, GraphMutationPort }
