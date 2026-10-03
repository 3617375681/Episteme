# Roadmap — placeholder

This directory is reserved for the plan. What exists today is the Phase 0 scope, and it is recorded
in two durable places rather than here:

- the closed loop v0 must demonstrate — [`README.md`](../../README.md);
- the acceptance criteria that decide whether it works —
  [`tests/northstar.test.ts`](../../tests/northstar.test.ts) and the testing section of
  [`architecture/overview.md`](../architecture/overview.md).

## Phase 0 — verify the loop (current)

The only goal:

> Can the system remember how one person's understanding changed, and let that change actually affect
> the next interaction?

Delivered: Core (ontology, registries, graph, Engram, guards, projection), the Learn pack, in-memory
storage, the agent interface with a mock, a runnable demo, and the three North Star tests.

Not delivered, on purpose: any application, any real model, any database, any second scene.

## The gate to anything else

The three questions must be a clear **yes**:

- **A** — "I used to understand it this way, and now I understand it differently."
- **B** — "From that same earlier understanding, I later took two different paths."
- **C** — "Because I understood it this way before, today's answer is different."

If any of these is not a clear yes, the answer is to stop adding features rather than add more of
them. They currently pass; they must keep passing.

## Explicitly out of scope for now

Scope creep is the main risk to this project:

```text
multi-agent systems            recommendation engines
automatic curriculum generation   reputation ranking
leaderboards                   semantic automatic merge
AI truth oracles               automatic knowledge-graph generation
federation                     institutional deployment
payments                       complex governance
educational-effect experiments  full Lean integration
```

An agent interface exists in [`packages/agent`](../../packages/agent/README.md), but only as a
scripted mock.

## Candidate next slices, in no committed order

Each is a documented placeholder until something depends on it:

- **Relevance retrieval** — the honest gap in the loop. `packages/agent` currently receives whatever
  a projection happens to include; finding _relevant_ history at scale needs an embedding or search
  adapter, which is what makes Test C work for a real learner rather than a demo.
- **`storage-local`** — durability, so a restart does not erase the graph. See
  [`packages/storage-local`](../../packages/storage-local/README.md). The event log is the first thing
  that must be durable, since current state is derivable from it and never the reverse.
- **`domain-forum`** — the second scene, and the real test of the claim that one graph serves many
  views. It must reuse `concept`, `question`, `claim` and `thought` rather than defining parallel
  ones. See [`packages/domain-forum`](../../packages/domain-forum/README.md).
- **Access and policy** — the privacy default is expressed in the model (`Actor.shareByDefault`,
  per-actor state) but not yet enforced. Until it is, "private by default" is a design intention
  rather than a guarantee.
- **`sdk`** — a `createEpisteme({...})` composition point, once a second consumer duplicates the
  wiring that [`tests/fixtures.ts`](../../tests/fixtures.ts) currently performs by hand.
- **A real model provider** — behind the existing `CognitiveAgent` interface, once the loop is stable
  enough that a model's contribution can be distinguished from the history's.
- **Formalisation** — starting with Datalog rather than Lean, since it can express many relational
  claims about a graph cheaply. See [`packages/logic-bridge`](../../packages/logic-bridge/README.md).

## How to add a slice

Write the ADR first if the change touches Core's boundary, the event model, or any invariant listed in
[`AGENTS.md`](../../AGENTS.md). Otherwise: understand, design, document, implement the minimum slice,
test, refactor, continue.
