# @episteme/sdk — placeholder

Not implemented. This directory records the intended shape of the public surface; it contains no
code and is not a workspace package yet.

Today every consumer imports `@episteme/core` directly, including the `learn` pack, the memory
adapter and the demo. That is fine while Core is the only publisher and there is one consumer of
each seam. A separate SDK earns its place when one of these becomes true:

- an Application needs a narrower, stable surface than Core's full ontology;
- external code needs to build a domain pack without depending on Core's internals;
- a convenience layer is wanted that should not live in Core (for example
  "create a claim and record this state" as one call, or a scoped, actor-bound graph handle).

## What it must not become

A second way to do things Core already does. If the SDK grows its own mutation path, there would be
two ways to write to the graph and the single-validation-path invariant would be broken. It should
compose Core's public API, not reimplement or bypass it.

## The likely first shape

A thin composition layer:

- `createEpisteme({ storage, packs, clock, actorId })` returning a wired graph, event log and
  registries in one call — replacing the constructor dance the tests and demo currently repeat;
- an actor-bound handle so that `commit` does not need `actorId` passed at every call;
- a projection helper that turns a `Projection` into the shape a view actually renders.

Note that the fixture in `tests/fixtures.ts` already performs that wiring by hand. When a second
consumer needs the same wiring, that duplication is the signal to promote it here.

## Prerequisites before implementing

- A second consumer that would otherwise duplicate Core wiring.
- Clarity on whether the SDK is published or internal; that decides how much of Core it re-exports.

See the [architecture overview](../../docs/architecture/overview.md) and
[ADR 0001](../../docs/decisions/0001-core-boundary.md).
