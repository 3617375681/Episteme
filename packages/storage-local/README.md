# @episteme/storage-local — placeholder

Not implemented. This directory records the intended shape of a durable local storage adapter;
it contains no code and is not a workspace package yet.

`@episteme/storage-memory` is the only backend today, so a process restart loses the graph. This
package is where that gets fixed, and it must not require any change to Core.

## What it must implement

`GraphStorageAdapter` from `@episteme/core` — a `GraphReadPort` (`getNode`, `getEdge`,
`listNodes`, `listEdges`, `edgesOf`) plus a `GraphMutationPort` (`putNode`, `putEdge`,
`deleteNode`, `deleteEdge`). Nothing more: see
[ADR 0004](../../docs/decisions/0004-storage-and-identity-seams.md) for why the port has this
exact shape.

Two things it must **not** do:

- **Enforce rules.** The port is deliberately low-level and unguarded; `validateMutation` is the
  single authority and lives in the graph layer. A backend that also validated would be a second,
  divergent authority.
- **Invent identity or time.** Ids and timestamps arrive on the entities from the caller.

## Candidate technology

SQLite is the expected choice: a single-file, zero-configuration, transactional store that suits a
personal cognitive graph. Deciding _this_ is not necessary to decide the port, which is the point
of having the port.

## What actually needs care

- **Adjacency.** `edgesOf(nodeId)` is in the read port because it is the one operation a backend can
  do meaningfully better than Core can. It needs a real index, since projection traverses it.
- **Event history durability.** The event log is the source of truth, so it must be the first thing
  that is durably stored and the last thing that could be lost. Current state is derivable from it,
  never the reverse.
- **Cross-actor isolation.** Personal state is private by default, so a query for one actor's
  understanding must not be satisfiable by another's rows.
- **Revoke, not delete.** `state:revoked` hides content from queries by default. Physical deletion
  is reserved for privacy, legal compliance and account deletion, and must be an explicit
  operation rather than a side effect.

## Migration expectation

The existing `tests/` suite should pass against this adapter with only the storage constructor
changed. If a backend needs a semantic difference to pass, the port is wrong rather than the
backend — that is the signal to revisit ADR 0004.
