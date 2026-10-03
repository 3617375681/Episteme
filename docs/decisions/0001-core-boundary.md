# 0001 — The Core boundary

## Context

Episteme is meant to serve learning, discussion, research and other scenes that do not exist
yet. The obvious way to build the first one is to write a learning product, and the obvious way
to write a learning product is to let the model of a course, a quiz and a learner's progress
accumulate in the centre of the codebase.

That produces a system where a second scene cannot reuse anything: a discussion would need its
own notion of a claim, and a correction made while learning could not reach the discussion. It
also produces a centre that cannot be tested without a database, a model or a frontend.

The alternative is to decide, before writing code, what the graph itself must know and what it
must not. That decision is hard to reverse later, because by then the vocabulary has spread.

## Decision

Four layers, with a strict one-directional dependency: **Adapters ← Core ← Domain Extensions ←
Applications**. Core does not import a domain or an application; a domain pack registers into
Core; an application reads Core through the SDK.

**Core contains only graph primitives:** the ontology (`Node`, `Edge`, `Actor`, `Tag`,
`StateEvent`), registries for types and dimensions, the graph façade, the event log, guards,
projection and the storage port. It runs and is tested with no frontend, no model and no
database.

**Core contains none of the following**, now or later: recommendation, voting, hot-ranking,
course generation, quizzes, reputation, leaderboards, community moderation, agent workflows, UI
state and teaching strategy. These are Domain or Application concerns.

Everything that gives content meaning beyond structure enters through a registry:
`registerNodeType`, `registerEdgeType`, `registerStateDimension`, `registerTagNamespace`,
`registerGuard`, `registerProjectionRule`, `registerQueryOperator`. Vocabulary must be registered
before use, and re-registering an id is an error rather than an overwrite, because silently
replacing a definition would invalidate everything already stored under it.

The decision rule for new work, asked in order:

1. Is this a graph primitive? → Core
2. Is this a cross-application domain rule? → Domain Extension
3. Otherwise → Application

## Alternatives

**One package, layered by folder.** Simplest to start. Rejected because nothing prevents an
application concern from being imported by the model, and the boundary would erode under
deadline pressure. A dependency direction that is checked by the build is worth more than a
convention documented in a file.

**Core plus a schema-per-domain, with no shared node types.** Maximum isolation, and a domain
could evolve its vocabulary freely. Rejected because it directly contradicts the project's
premise: Learn and Forum must share `Concept` and `Claim` so that a thought written while
learning can be contributed to a discussion without conversion.

**A general RDF/OWL style triple store as the centre.** Expressive and standards-based. Rejected
for v0 because the project's risk is not expressiveness — it is whether understanding can be
tracked and reused at all. Starting from formal semantics would have made the interesting
question harder to test, and the storage port leaves the door open.

**A conventional document/ORM model with a status field.** Familiar and fast to build. Rejected
because it cannot represent the two things this project exists for: a change of mind that keeps
its earlier state, and one point in time producing two different lines of inquiry. See
[ADR 0002](0002-event-sourced-cognition.md).

**Property schemas validated with a library such as Zod.** Rejected _for now_, not on principle:
v0 validates the presence of required property keys and nothing more. Full schema validation is a
replaceable choice behind `NodeTypeDefinition`, so a library can be introduced later without
touching any Core call site.

## Consequences

- Adding a scene does not require changing Core; the `Learn` pack proves this, and `Forum` is
  expected to reuse the same node types.
- Core's tests need no infrastructure. `pnpm test` runs the whole domain model in memory.
- Some duplication is accepted where a domain needs a rule Core cannot express. Anchoring is
  Learn's vocabulary, so "a Thought must have a source and at least one existing anchor" is a
  registered guard rather than a Core rule.
- Registration adds ceremony: a new kind of content needs a registered type before it can be
  stored. This is the point — an unregistered type would be invisible to validation, projection
  and every future migration.
- The layer names are enforced socially, not mechanically. A package boundary that imports Core
  could still call application code; keeping packs declarative (`defineDomainPack`) makes the
  intended shape the easy one.
- Risk to watch: Core growing convenience methods that only one scene needs. The decision rule
  above exists to make that visible when it happens.
