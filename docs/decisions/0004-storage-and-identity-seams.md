# 0004 — Storage and identity seams

## Context

Episteme will eventually be stored in SQLite, PostgreSQL or a graph database, and will be read
and written by more than one actor, some of them agents. Two decisions could make that migration
painful or unsafe, and both are much cheaper to make now than to retrofit:

- whether the graph talks to a database directly;
- how identities and timestamps are produced.

They are recorded together because they are the same kind of decision — where Core's dependence on
the outside world is allowed to sit. Both are about keeping the graph a pure function of its
inputs, so that histories are reproducible and a backend can be replaced without touching the
model.

## Decision

### Storage is a port

Core declares `GraphStorageAdapter` (a `GraphReadPort` plus a `GraphMutationPort`) and depends on
nothing else. `@episteme/storage-memory` is the v0 implementation, deliberately plain: Maps plus
an adjacency index, because traversal is the hot path for projection.

`GraphMutationPort` is intentionally low-level and unguarded. Enforcement lives in the graph layer,
which calls `validateMutation` before every write, so there is exactly **one** code path that can
change the graph and no adapter can bypass a guard. A backend that enforced its own rules would
create a second, divergent authority.

The port is not minimal-by-aspiration: `edgesOf(nodeId)` is in the read port rather than being
derived from `listEdges()`, because it is the one operation where a backend can plausibly do
better than Core can, and inventing an index later would mean changing the port anyway.

### Identity and time are supplied

Core never invents an id and never reads the wall clock. Callers pass:

- a `Clock` (`now(): EpochMillis`), with `systemClock` for production and `createFixedClock` for
  tests and the demo;
- an `IdFactory` (`eventId()`, `branchId()`), with `createSequentialIdFactory` as the default;
- node and edge ids on the draft (`GraphNodeDraft.id`), because a mutation must be fully
  describable before it is committed — which is exactly what the preview/suggestion flow needs.

Ids are **branded strings** (`Brand<string, 'NodeId'>`), so passing an `ActorId` where a `NodeId`
is expected is a compile error. `asId` is the single sanctioned entry point for turning external
input into an id.

The only id Core generates itself is a branch for an actor who has never committed, which is a
consequence of lazy branch creation rather than a hidden identity decision.

### State reduction is a pure function

`foldEvents` takes events and returns a `DimensionIndex`. It has no hidden parameters, so the same
events always produce the same state. The cache inside the event log is an optimisation over that
function and nothing more.

## Alternatives

**Talk to SQLite directly from Core.** Fewer moving parts for v0 and no interface to design.
Rejected because the choice of backend would then be embedded in the domain model, and the
migration cost would land exactly when the graph is largest.

**An ORM or repository base class per entity.** Familiar structure, less hand-written mapping.
Rejected because the graph is a graph: nodes and edges are not independent tables to be loaded,
and an ORM's unit-of-work semantics would conflict with append-only mutation.

**Generate ids from time plus randomness (UUID, nanoid).** Convenient and collision-resistant.
Rejected inside Core because it makes histories non-reproducible: a test could not assert on the
same output twice, and the demo's narrative would change between runs. Ids are the caller's
responsibility precisely so they can be deterministic where that matters.

**Read the wall clock inside Core.** Would remove a parameter from every constructor. Rejected
because time is part of the data in an event-sourced system — "when did this happen" is a
recorded fact — and an unreplayable history undermines the reduction guarantee.

**Plain `string` ids.** Simplest, and it is what the code does at runtime. Rejected because the
system mixes actor, node, edge, event and branch ids, and a silent swap between them is a
plausible bug that cannot be caught by a type checker otherwise. The cost is one brand type per
kind and a single cast at the boundary.

**A separate `@episteme/types` package for shared contracts.** Would let domains depend on types
without depending on Core. Rejected for now because Core is the only publisher, nothing depends on
anything else yet, and an extra package would be structure without a consumer. Revisit when a
second consumer appears that must not import Core's implementation.

## Consequences

- Swapping the backend means implementing one interface and changing one constructor argument.
- Tests and the demo run on a fixed clock and sequential ids, so output is byte-stable and
  regressions show up as diffs.
- Every mutation is describable before it happens, which is what makes
  `previewNode`/`previewEdge` and the "agent suggests, human confirms" flow possible.
- Branded ids cost a cast at each boundary, and adapter authors must remember not to validate: the
  graph layer owns that, and duplicating a rule there would create a second authority.
- `storage-local`, `storage-postgres` and a graph backend are expected to differ mostly in
  indexing strategy, not in semantics. If one needs a semantic difference, that is a signal the
  port is wrong rather than the backend.
