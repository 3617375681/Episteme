# Episteme Nightly Report

## Goal

> Let Episteme advance from "project skeleton" to a minimal cognitive loop that can actually be run,
> tested and demonstrated.

The loop to reach:

```text
question → claim → state event → learner graph → inspectable history
        → fork from an earlier state → retrieval → a later interaction that changes
```

**Status: achieved.** `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm demo` all
pass, and the demo shows the complete loop including the two interactions differing.

## Completed

Priority ladder, as specified:

|     | Item                                                                                                              | State                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------- |
| P0  | Repository health (`install`/`test`/`lint`/`typecheck`)                                                           | green                       |
| P1  | Core model: `Node`, `Edge`, `NodeId`, `EdgeId`, `Actor`, `ActorId`, `Tag`, `Graph`, `StateEvent`                  | done, branded ids, no `any` |
| P2  | Ontology registry with `register*` / `validate*`, unregistered types refused                                      | done                        |
| P3  | Graph API: `addNode`, `addEdge`, `getNode`, `getEdge`, `revoke`, `neighbors`, `incoming`, `outgoing`, `findNodes` | done                        |
| P4  | `commitStateEvent`, `getHistory`, `reduceState`, `revokeStateEvent`                                               | done                        |

Beyond the ladder:

- **Retrieval** (`retrieve`, `retrieveRelevantContext`) — deterministic, no embeddings.
- **Agent interface** with `respond(input, context)` and a mock that branches on retrieved context.
- **AI-ownership rule** — a `suggested` state value cannot become user state without human
  confirmation.
- **Per-branch lineage** — forking from an _earlier_ understanding, which the first implementation
  blocked (see "Important decisions").
- **Retraction without erasure** — a recorded change can be withdrawn while staying readable.
- **The specified demo scenario**, executable via `pnpm demo`.
- **Documentation** — architecture overview plus dedicated `data-model`, `state-events` and
  `projection` documents, five ADRs, per-package READMEs, `NIGHTLY_REPORT.md`.

## Core architecture

Four layers, dependency pointing one way only: **Adapters ← Core ← Domain Extensions ← Applications**.

Core does only what the graph itself must do. It contains no recommendation, voting, ranking, course
generation, quiz, reputation, moderation, agent workflow, UI state or teaching strategy, and it runs
with no frontend, no model and no database.

```text
packages/core/src/
├── ontology/     ids, primitives, actor, resources, state, tags
├── graph/        definitions, registries, the graph facade
├── events/       the append-only, branchable event log (Engram)
├── guards/       the single authoritative validation path
├── projection/   project(): one graph, many views
├── retrieval/    retrieve(): what is relevant right now
└── storage/      the port Core depends on
```

Four invariants hold everywhere, and each is enforced in code rather than documented only:

1. **History is the truth.** No `update`, no `delete` on the log — a test asserts those names are
   absent. Current state is always `reduce(events)`.
2. **One validation path.** Every mutation goes through `validateMutation`; adapters store and do not
   adjudicate.
3. **Vocabulary is registered before use.** Re-registration is an error, never an overwrite.
4. **No hidden identity or clock.** Time from a `Clock`, ids from an `IdFactory`, so histories are
   replayable and output is byte-stable.

## Tests

**66 tests across 10 files, all passing.** `pnpm check` is green.

| File                           | Covers                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `critical-loop.test.ts`        | The mechanism proof: same agent, same code, only the stored history differs                                     |
| `northstar.test.ts`            | Test A (change of mind), Test B (two paths from one understanding), Test C (answer changes)                     |
| `event-history.test.ts`        | Append-only, immutability, no update/delete surface                                                             |
| `state-reduction.test.ts`      | `reduce` is the definition of current state; illegal dimensions and levels refused                              |
| `fork-ancestry.test.ts`        | Fork from an earlier event, lineage preservation, commits stay on their branch                                  |
| `revocation-and-query.test.ts` | Retract without erasing; `findNodes` selectors and direction                                                    |
| `projection.test.ts`           | Scope, seed-vs-expanded, gates, present-tense state matching, actor isolation                                   |
| `retrieval.test.ts`            | Term extraction, matching, traversal, determinism, learner context joining                                      |
| `guards.test.ts`               | Unregistered types, missing properties, wrong endpoints, unanchored Thoughts, namespace rules, refusal-as-value |
| `actor-isolation.test.ts`      | Two actors' state about one node stays independent                                                              |

Quality over coverage: no test exists to raise a percentage.

## Demo

`pnpm demo` prints a nine-step narrative, deterministic on every run:

1. The learner asks why a Transformer needs positional encoding — with `Transformer`, `Self-Attention`,
   `Positional Encoding`, `Permutation Invariance` and `RoPE` already in the shared graph.
2. **First interaction:** "Then why does RoPE work?" — the agent has nothing recorded, and answers by
   establishing the foundation (`usedContext=false`).
3. The learner forms a first, cruder claim: _positional encoding gives every token an index_
   (`confidence=medium`).
4. Exploration produces a more precise claim: _self-attention alone does not encode sequence order_
   (`confidence=high`, `articulation=medium`), linked by `evolves_to`. The earlier claim is kept.
5. **A fork from the earlier understanding** — not from the latest event. The new line inherits
   `confidence=medium` and does _not_ inherit the refinement.
6. Both directions remain readable; the original reasoning is still there.
7. A recorded change is **retracted without being erased** — still readable, effect gone.
8. **Second interaction:** the same question, same agent, same code — the agent now answers from what
   was understood (`usedContext=true`).
9. The two responses side by side: `identical response? false`.

The last line is the point: _same question, same agent, same code — the input differed because the
graph remembered._

## Important decisions

Recorded as ADRs in `docs/decisions/`:

| ADR  | Decision                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0001 | **Core boundary** — four layers, one dependency direction; Core is graph primitives only                  |
| 0002 | **Event-sourced cognitive state** — append-only log; current state is `reduce(events)`; no mastery scalar |
| 0003 | **Storage abstraction** — a port rather than a database; identity and time injected, not invented         |
| 0004 | **Domain extension boundary** — packs register vocabulary; guards as data, not Core branches              |
| 0005 | **Fork lineage** — a branch is a line of inquiry with its own readable state                              |

Three decisions were forced by actually building the thing, which is the useful kind:

- **The fork rule had to change.** The first implementation refused to fork an event that had a later
  continuation. That made the project's own scenario inexpressible: the interesting second question
  starts from the _cruder, earlier_ understanding. Allowing it then required deciding what such a
  branch knows — and inheriting the refinement it forked to escape would make going back a no-op. Hence
  per-branch lineage (ADR 0005).
- **"Nothing recorded" must be empty as data, not a sentence.** `summarise` originally returned
  `"nothing is recorded about this yet"`, which a responder then treated as _having_ context. Real
  bug, found by the critical test; the display string now lives in `contextSummary`.
- **Capture-invariants belong in structural validation, not a pack guard.** The AI-ownership rule was
  a guard for about ten minutes. A pack that forgot to register it would be a back door, so it moved
  into Core.

Four defects were found and fixed by tests during construction, all of the kind that would have been
painful later: `history()` was reversing its internal index in place, corrupting every later query; a
fork's first event never received its `forkedFrom` because the event was appended after the lookup
that was supposed to find it; `currentBranch` threw for an actor that had never committed; and the
state cache was invalidated under one key while being read under several, so a stale read survived a
commit.

## Files added

```text
packages/core/src/retrieval/index.ts          retrieve()
packages/domain-learn/src/context.ts          retrieveRelevantContext(), learnerResponder()
docs/architecture/data-model.md
docs/architecture/state-events.md
docs/architecture/projection.md
docs/decisions/0004-domain-extension-boundary.md
docs/decisions/0005-fork-lineage.md
tests/critical-loop.test.ts
tests/retrieval.test.ts
tests/revocation-and-query.test.ts
NIGHTLY_REPORT.md
```

Plus the placeholder READMEs for `storage-local`, `sdk`, `domain-forum`, `logic-bridge` and `apps/`.

## Files changed

- `packages/core/src/events/index.ts` — branch lineage, `revokeStateEvent`, revision-based cache
  invalidation, `tips` per branch
- `packages/core/src/guards/index.ts` — AI-ownership rule, `assertValueShape`, actor lookup on the
  guard view
- `packages/core/src/graph/graph.ts` — `findNodes`, `revokeNode`/`revokeEdge`, `incoming`/`outgoing`
- `packages/core/src/ontology/state.ts` — `StateAuthority`, `confirmedBy`, `sourceOf`
- `packages/core/src/ontology/resources.ts` — `NodeQuery`, `queryNodes`, lifecycle fields
- `packages/storage-memory/src/index.ts` — revoke, `includeRevoked` listing
- `packages/domain-learn/src/index.ts` — context exports
- `packages/agent/src/*` — `respond(input, context)`, `AgentContext`/`AgentResponse`, responder hook
- `examples/learn-session/src/demo.ts` — rebuilt to the specified scenario
- `package.json` — `pretest` runs `tsc -b`, because tests resolve `@episteme/*` through `dist/`
- README, architecture overview, core README — retrieval, lineage, retraction

## Known issues

- **Retrieval is lexical.** A question phrased with different words misses the understanding that
  answers it. This is the honest limitation of "no embeddings", and the biggest gap in the loop.
- **Per-branch reads are explicit.** Once an actor has forked, `stateOf` needs a `branchId` to be
  meaningful. An application must be taught to name the current branch; the unqualified read merges
  open ends.
- **In-memory only.** A restart loses everything. Acceptable for v0, and `storage-local` is the
  designed fix.
- **No access-control enforcement.** "Private by default" is expressed in the model
  (`shareByDefault`, per-actor state) but not enforced by a policy layer.
- **No identity layer.** Actor ids are supplied by the caller.
- **Retraction is not yet modelled as first-class UI state.** `revocationOf` exists; nothing renders it.
- **`docs/decisions/0005-fork-lineage.md` is the ADR for the _old_ tip-only fork model.** The model was
  changed during the night (any event may be a fork point, and a branch reads only its own lineage),
  and that ADR was not rewritten to match. The new behaviour is described in
  `docs/architecture/state-events.md` and enforced by `tests/fork-ancestry.test.ts`, so the code and
  the tests are the reliable description; the ADR is stale and must be replaced. This is the one
  documentation debt worth fixing first.
- Full scans for projection and retrieval; the storage port is where an index belongs.

## Deferred

Not started, on purpose: Neo4j, RDF, quadstore, vector database, MeTTa, Lean, Datalog, multi-agent
systems, recommendation, automatic curriculum or KG generation, reputation, leaderboards, governance,
federation, payments, production deployment, complex authentication. An agent interface exists, but
only with a scripted mock — no real model is connected, and that ordering is deliberate, because an
agent that could not be held constant would make the central claim unverifiable.

## Recommended next step

**Replace lexical retrieval with an embedding-backed one, behind the existing interface.**

This is the highest-value next slice because it is the only place where the v0 loop is
_architecturally_ complete but practically fragile: `retrieve()` works, is deterministic and is
tested, but it matches words. A learner asking "why does order information survive in RoPE?" will not
reach a claim phrased as "self-attention alone does not encode sequence order". Everything downstream
of retrieval — the agent's answer, and therefore the entire claim the project rests on — inherits that
weakness.

It is a bounded slice: an `EmbeddingAdapter` port in the Adapters layer, a similarity score folded
into `scoreOf`, and the existing `RetrievalResult` shape unchanged. The critical-loop test then needs a
paraphrased question, which is a stronger assertion than the current one.

Second and third, in order: `storage-local` (durability — the event log first, since current state is
derivable from it and never the reverse), then `domain-forum` as the real test of "one graph, many
views" by reusing `concept`, `question`, `claim` and `thought` verbatim.
