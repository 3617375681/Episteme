# Episteme

> **Episteme turns inquiry into persistent, evolving understanding.**
> Episteme 让探索沉淀为可持续演化的理解。

Episteme is open cognitive infrastructure for carrying, organising and evolving _human
understanding_. It is not a chat assistant, a knowledge base, a course generator or a forum.

The problem it addresses is not "how do we let an AI answer faster", but:

> How do we make the understanding produced while exploring a question, learning something,
> discussing it or researching it — structured, kept, branched, corrected, compared and
> reused, so that it keeps shaping how people and AI interact later?

The system's most valuable asset is not a chat log and not course content. It is a
**cognitive graph that keeps evolving**, because a lesson learned, an argument had, a doubt
raised or a position revised can each change that graph.

```text
Question
    ↓
Exploration
    ↓
Understanding
    ↓
State change
    ↓
Persistent cognitive graph
    ↓
Future interaction changes
```

## Status

Phase 0. The whole point of v0 is to verify exactly one thing:

> Can the system remember how one person's understanding changed, and let that change actually
> affect the next interaction?

Running `pnpm demo` completes that loop end to end — a question, a claim, a state change, a
fork, and a later answer that differs _because_ of what was stored — with no database, no
language model and no frontend. Everything else is deferred on purpose; see
[What v0 does not do](#what-v0-does-not-do).

## Quick start

```bash
pnpm install
pnpm check     # typecheck + lint + tests
pnpm demo      # the v0 closed loop, printed as a narrative
```

## Layout

```text
episteme/
├── packages/
│   ├── core/               Episteme Core — ontology, graph, state, events, guards, projection
│   ├── domain-learn/       Learn domain pack: vocabulary and rules for the Learn scene
│   ├── storage-memory/     In-memory GraphStorageAdapter (the v0 backend)
│   ├── agent/              CognitiveAgent interface + scripted mock (no real model yet)
│   ├── sdk/                [placeholder] public convenience surface
│   ├── domain-forum/       [placeholder] Forum domain pack
│   ├── storage-local/      [placeholder] durable local adapter
│   └── logic-bridge/       [placeholder] optional formalisation (Lean, Datalog, SMT)
├── apps/                   [placeholder] application shells: learn, forum
├── examples/learn-session/ Runnable v0 closed loop
├── tests/                  Cross-package tests, including the three North Star questions
└── docs/                   architecture, concepts, decisions (ADRs), roadmap
```

Only packages that do something exist as code. The rest are documented placeholders rather
than empty shells, so that the intended shape is visible without pretending it is built.

## Architecture in one screen

```text
┌──────────────────────────────────────────────────────────┐
│ Applications        Episteme Learn / Forum / Research     │
│                     UI, interaction, ranking, feeds       │
├──────────────────────────────────────────────────────────┤
│ Domain Extensions   Learn Pack / Forum Pack / Research    │
│                     domain schema, guards, projections    │
├──────────────────────────────────────────────────────────┤
│ Episteme Core       Ontology · Graph · State · Tag        │
│                     Version · Access · Query · Guard      │
│                     Projection                            │
├──────────────────────────────────────────────────────────┤
│ Adapters            Storage · LLM · Embedding · Logic     │
└──────────────────────────────────────────────────────────┘
```

The rule that keeps this honest:

> **Core only does what the graph itself must do.**

Recommendation, voting, hot-ranking, course generation, quizzes, reputation, leaderboards,
moderation, agent workflows, UI state and teaching strategy belong to a Domain Extension or an
Application. Putting any of them in Core would stop one ontology from serving Learn, Forum and
Research at once.

## Core ideas

**One graph, many views.** Learn, Forum and Research do not maintain separate knowledge
systems. They share one graph and project different views of it, differing by scope, actor,
topic, state and projection rule — not by data model.

**Understanding is not a mastery score.** There is no `mastery = 0.73`. State is a small set
of independent axes — `exposure`, `confidence`, `evidence`, `articulation`, `transfer`,
`conflict`, `source` — each moving on its own schedule. A learner can be confident and unable
to articulate, or fluent and full of unresolved conflict, and collapsing that into one number
would destroy exactly the information the system exists to keep.

**History is the truth.** Nothing is overwritten. There is no `claim.status = "understood"`
that buries what came before. Current state is `reduce(events)` over an append-only,
branchable event log, so cognitive history naturally forms a DAG and "I used to understand it
this way" is a first-class, queryable fact.

**Forking is first-class.** `fork(historyNode)` continues from a point in the past without
touching it, which requires interaction history to be a graph rather than an append-only
message list. A conversation is a view; the graph is the substrate.

**Draft → Thought → Reference.** Not all content is understanding. A raw AI transcript is a
draft and stays out of the graph until a human deliberately organises it. A `thought` must
carry a source and at least one anchor. A `reference` is public, sourced and verified — not
"absolute truth", just public knowledge with a traceable context and verification record.

**AI is a cognitive scaffold, not the author of the user's thinking.** An agent may ask
questions, offer counterexamples, suggest claims, concepts, edges, state changes and
syntheses. Everything it infers is `suggested` until the human accepts, modifies or ignores
it. An agent may never write to the graph or decide which side of a conflict is right.

**Conflict does not disappear.** If two claims contradict, Episteme preserves the conflict
with both authors, sources, evidence, times and states. Its job is to keep the structure of
disagreement, not to pretend knowledge is naturally consistent.

**Private by default, contributed deliberately.** Personal state events and claims are
private; concepts and references are public or controlled; contribution is an explicit
opt-in.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [ADR 0001 — The Core boundary](docs/decisions/0001-core-boundary.md)
- [ADR 0002 — Event-sourced cognition](docs/decisions/0002-event-sourced-cognition.md)
- [ADR 0003 — Fork semantics](docs/decisions/0003-fork-semantics.md)
- [ADR 0004 — Storage and identity seams](docs/decisions/0004-storage-and-identity-seams.md)

## What v0 does not do

Scope creep is the main risk to this project, so the following are explicitly out of scope for
now: multi-agent systems, recommendation engines, automatic curriculum generation, reputation,
leaderboards, semantic auto-merge, AI truth oracles, automatic knowledge-graph generation,
federation, institutional deployment, payments, complex governance, educational-effect
experiments, and full Lean integration.

An agent interface exists in `packages/agent`, but only as a scripted mock. Connecting a real
model is deferred until the Core and Learn loop is stable — an agent that could not be held
constant would make the central claim unverifiable.

## Technical principles

Simple, typed, modular, testable and replaceable — rather than clever, complex or prematurely
distributed. TypeScript, a pnpm workspace monorepo, Vitest, ESLint and Prettier.

The domain model runs and is tested **without a frontend, without an LLM and without a
database**. That is a design constraint, not an accident: it is what allows the ontology to
outlive any particular product surface.
