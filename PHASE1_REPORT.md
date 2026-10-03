# Episteme — Phase 1 Report

## Goal

> Move Episteme from an in-memory cognitive prototype to a persistent local cognitive system, so that a
> user's understanding survives process restart and still affects future interaction.

**Status: achieved.** `pnpm install`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass, and
`pnpm demo:persistent` shows a learner's understanding going to disk, the instance being dropped, and a
fresh instance answering differently because the memory came from the file.

```
pnpm install          ✓
pnpm typecheck        ✓
pnpm lint             ✓
pnpm test             ✓   86 tests across 13 files
pnpm demo             ✓   Phase 0 loop, unchanged
pnpm demo:persistent  ✓   Phase 1 loop, across a restart
```

---

## Storage design

Two ports, both in Core, both implemented by one adapter.

```text
Core                          @episteme/storage-local
────────────────────────      ─────────────────────────────────────────
GraphStorageAdapter      ←──  nodes, edges, revocations   (synchronous reads)
PersistentEventStore     ←──  branches, events, retractions (async load/save)
```

`GraphStorageAdapter` already existed. `PersistentEventStore` was added:

```ts
interface PersistentEventStore {
  load(): Promise<EventLogState | undefined>
  save(state: EventLogState): Promise<void>
}
```

**Core's semantics were not changed to accommodate a database.** Guards, reduction, forking, projection
and actor isolation are untouched. The only other Core change was an optional `resume()` on `IdFactory`,
so a reloaded history cannot reuse an id.

### The problem this design had to solve

Core's graph port is **synchronous** (`putNode`, `getNode`); durable storage is naturally
**asynchronous**. Rather than make every read a promise, the adapter loads everything into memory on
`open()` and writes on `save()`. Reads stay synchronous; durability is an explicit act at a boundary the
caller understands, instead of an invisible write per mutation whose failures nobody observes.

### Ordering is the subtle part

```text
1. read the store              (what history exists?)
2. build the graph             (over that storage)
3. build the event log         (validating against that graph)
4. wire the graph to the log   (so state-filtered projections work)
```

Every commit is validated against the graph, so a log built before the graph has loaded rejects writes
that are perfectly legal — and that is not a type error. This ordering now lives in exactly one place,
[`@episteme/sdk`](../packages/sdk/README.md), because by the end of Phase 1 the wiring existed twice (a
test fixture and the demo).

The log receives the _unwired_ graph, exactly as before: validation needs nodes and edges, never state,
and wiring state into the validating view would make the two views mutually dependent.

---

## Persistence format

**One append-only JSONL file.** Each line is one record, stamped with a schema version and a kind:

```json
{"schemaVersion":1,"kind":"branch","branch":{"id":"br_1","actorId":"actor_human","createdAt":2}}
{"schemaVersion":1,"kind":"event","event":{"id":"evt_1","branchId":"br_1","target":"claim_order",
  "actorId":"actor_human","dimensions":[["confidence",{"level":"high"}]],"createdAt":3}}
{"schemaVersion":1,"kind":"node","node":{"id":"claim_order","type":"claim", ... }}
```

| Stored          | Why it is a fact rather than derived data                    |
| --------------- | ------------------------------------------------------------ |
| `branch`        | lineage (`parentBranchId`, `forkPoint`) cannot be recomputed |
| `event`         | the history itself; dimensions as an array of pairs          |
| `node` / `edge` | structure, including `revoked` / `revokedAt`                 |
| `revocation`    | a retraction is appended data, not a mutation                |

**Reduced state is never written.** Current understanding is always `reduce(events)` over the reloaded
log. The branch→events index and the subject index are rebuilt on load — and that is not merely tidy:
persisting `branchEvents` was the first bug found here, because the empty arrays it wrote shadowed the
rebuilt index and made every branch look like it held nothing.

### Why JSONL and not SQLite

`node:sqlite` is available on this machine but experimental and Node-24-only, and a native driver would
put a build step between a learner and their own history. JSONL needs nothing, runs on the Node the
project already targets, and is readable and diffable by a human — which matters for a system whose
whole claim is that its records are inspectable. A personal cognitive graph is written at human speed,
so scanning it is not the constraint. It is a port: a SQLite backend can replace it without Core
changing. Full reasoning in [ADR 0006](decisions/0006-persistence-format.md).

### Migration and versioning

- Every record carries `schemaVersion`. A reader that does not recognise it **throws** rather than
  skipping, because silently ignoring a line presents a truncated history as a complete one.
- An unknown `kind` also throws.
- A half-written final line fails loudly, naming the line number. This is tested by truncating a real
  file mid-record.
- Bumping the version is a deliberate act that must come with a migration; nothing migrates
  automatically yet, which is the honest state of a schema that has only had one version.

---

## Recovery test

The Phase 1 claim is tested two ways, because "survives restart" and "survives in one process" are
different claims.

### `tests/restart-recovery.test.ts` — the loop

```text
session 1   storage A → openEpisteme → seed concepts → ask (no memory: usedContext=false)
                                         → form claim → commit StateEvent
                                         → fork a second line → persist → save
            (dropped; nothing shared with what follows)
storage B   new LocalStorageAdapter over the same file, empty in-memory state
session 2   openEpisteme → state equals the pre-shutdown state
                         → history ids equal the pre-shutdown history
                         → ask the same question → usedContext=true, answer differs,
                           and equals the in-process answer exactly
```

Also covered: ids do not collide after reload (a second commit gets a new id and both events remain
distinct), and an unrelated file does not inherit another file's cognition.

Honest limitation: the two sessions run in one Node process. The separation that matters is that no
object is carried between them — the _instance_ is rebuilt from a second adapter with empty state — and
`node dist/main.js` starts a genuinely new process each run. Spawning a child process inside the test
suite was not judged worth the fragility it would add.

### `tests/persistence-integrity.test.ts` — each guarantee separately

| Property                                   | How it is asserted                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Event order preserved                      | reloaded history ids equal pre-shutdown ids, in order                       |
| Branch ancestry preserved                  | `branchAncestry` equal, `parentBranchId` and `forkPoint` intact             |
| Revoked events remain historically present | `getEvent` still returns it, `isRevoked` true, `revocationOf().reason` kept |
| …and still absent from current state       | reduced `confidence` is the pre-revocation value                            |
| Actor isolation preserved                  | human `high` and agent `low` on the _same_ claim after reload               |
| Shared concepts remain shared              | the concept count and authorship survive; the node belongs to nobody        |
| State reduction matches                    | `stateOf` entries equal before and after                                    |
| Retrieval equivalent                       | same node ids **in the same order**, same summary, same joined `known`      |
| Same answer after reload                   | byte-identical response text to the pre-shutdown answer                     |
| Corrupt/incomplete file                    | a truncated final line rejects with a message naming the line               |
| Use before open                            | refused, rather than silently behaving as an empty graph                    |
| Missing file                               | treated as an empty history, not an error                                   |

---

## Retrieval architecture

Refactored behind the interface the phase asked for:

```ts
interface Retriever {
  readonly name: string
  readonly description: string
  retrieve(query: RetrieveQuery): Promise<RetrievalResult>
}
```

- **`LexicalGraphRetriever`** — the Phase 0 behaviour, unchanged, now behind the seam. A test asserts
  that reaching retrieval through the interface returns the same nodes, in the same order, as the
  original entry point.
- **`EmbeddingRetriever`** — **designed, not implemented.** It rejects with an explanation of what
  retrofitting requires. Rejecting rather than returning `[]` is deliberate: an empty result would read
  as "the learner understands nothing", which is a different and much worse claim than "this retriever is
  not available".

`RetrievalResult` is unchanged, and `retrieveRelevantContext` keeps working — it now delegates, and it
became asynchronous, which is the honest cost of a swappable strategy. Eight call sites were updated.

### Hybrid scoring (P7)

Documented in [docs/architecture/retrieval.md](docs/architecture/retrieval.md), with a formula and an
explicit refusal to pick weights:

```text
score(node) = w_semantic · semantic similarity
            + w_graph    · graph proximity
            + w_state    · actor-state relevance
            + w_recency  · recency
```

The architectural principle is stated with reasons, not just asserted:

- **Graph proximity belongs**, because the lexical retriever already exploits it — that is how a question
  about RoPE reaches a claim about sequence order at all. A pure vector retriever would _discard_ a
  signal that exists today, which is strictly worse.
- **Actor-state relevance belongs**, because Episteme knows something no generic retriever can: a node
  the learner holds with _low articulation and high confidence_ is the most valuable one to surface, and
  a node with an **open conflict** must be surfaced even when the question does not name it, because the
  agent may not build on a contested position. No similarity score can see either.
- **Recency is the weakest**, and exists mainly to make the order total and reproducible.

Weights are left unchosen on purpose: a table of invented constants looks considered and cannot be
validated. What _is_ specified is the shape they must have — no single signal may dominate, actor state
must be able to override similarity, and the result must stay explainable. The one hard property:
`w_semantic` must not be an order of magnitude above the rest, or this becomes vector RAG with extra
steps.

---

## The persistent demo

`pnpm demo:persistent` prints:

```text
Session 1 · the question, before anything is recorded
   Agent (usedContext=false): Let's build the foundation first. …

Session 1 · the learner forms an understanding and records it
   StateEvent evt_1 on branch br_1 → confidence=high, articulation=medium
   Forked evt_2 on branch br_2, continuing evt_1

Session 1 · writing to disk and stopping

Session 2 · a new instance, built from the file
   Reloaded 2 event(s)
   Reduced state of the claim: confidence=high, articulation=medium, evidence=reproduced, conflict=open
   Branch lineage: br_1 → br_2
   The fork point of br_2 is still recorded: evt_1

Session 2 · the same question, answered from the restored understanding
   Agent (usedContext=true): You have recorded an unresolved conflict here (open), so I will not build on it as settled. …

Session 2 · the difference is the point
   identical response? false
   Same question, same agent, same code — the memory came from disk.
```

The answer does not merely change wording — it changes **shape**. Session 1 forked a second line
recording `conflict=open`, so session 2 restores both the confidence _and_ the doubt, and the agent
answers the doubt instead of the confidence. That is a stronger demonstration than a reworded sentence,
because the difference is caused by data the agent was handed.

The demo also runs a control: a second instance over a file that was never written, seeded with the same
concepts, answering the same question with no memory. Without it the contrast would have to be taken on
trust.

---

## Commits

| Commit        | Contents                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `d2ff8f7`     | Phase 0 baseline: subject-aware branch reads, documentation                                               |
| `194979d`     | `feat(storage-local)`: the persistence port, serialization contract and durable adapter                   |
| _this commit_ | `feat(sdk)` + `feat(retrieval)`: composition, the Retriever seam, the persistent demo, the Phase 1 report |

Phase 0 consisted of five further commits (`d5272aa`, `3841161`, `8c9fb2b`, `c93ee00`, `a19e100`). No
pushes, no remote, no force-push; the working tree is left clean.

---

## P0 — documentation drift, repaired

Before any new capability, as instructed:

- **`docs/decisions/0005-fork-lineage.md` rewritten.** It described the old tip-only fork model, which
  the code no longer implements. It now documents what exists: `forkPoint`, a branch root's `parent`
  being its fork point, explicit ancestry stitching, `branchId` alone scoping a read, and **subject-aware
  tip resolution**.
- **`packages/core/README.md`** and **`docs/architecture/overview.md`** updated to match.
- Verified by search: no remaining reference to the old rule in code, tests, ADRs or architecture docs.

The `NIGHTLY_REPORT.md` known-issue entry about the stale ADR was the flag for this, and it is now
resolved.

### One more defect found during this phase

While wiring the restart test, `tips(actorId)` was found to return a branch's last event _regardless of
which node it was about_, so a branch whose most recent event concerned another node would hide this
node's open end. The `target` parameter was added, and subject-scoped resolution (`#lastOnBranchFor`) was
introduced for branch-scoped _reads_.

**Correction, found during Phase 2:** the `target` parameter was added to `tips()` but its body kept
resolving the branch-global tip and only filtered the result afterwards, so `tips(actorId, target)`
returned nothing whenever the branch had moved on to another subject. The commit message said "tips … are
now per subject" and this report repeated it; the code did not do it. Phase 2's branch-versus-subject
invariant test is what caught the discrepancy, and `tips()` now scans each branch for its most recent
event about the requested subject.

It is the same class of bug as the one above, which is why the distinction now has a dedicated test file
rather than a paragraph in a report: documentation asserting a fix is not evidence that the fix exists.

---

## Known issues

- **Retrieval is lexical.** A question phrased with different words misses the understanding that answers
  it. This remains the biggest gap in the loop and the recommended next step.
- **No encryption at rest.** The graph is plain text by design, and personal cognitive history is
  sensitive. This is the most serious gap introduced by Phase 1, and it is a deliberate trade for
  inspectability that should be revisited before any real use.
- **The whole file is rewritten on save, and scanned on open.** Fine at human scale; the port is where a
  chunked or SQLite backend would go.
- **No compaction.** Retracted events and superseded nodes accumulate.
- **Single file, last writer wins.** Concurrent processes on one file are not supported.
- **Durability is explicit.** A crash between a commit and `persist()` loses that commit. That is honest
  rather than silent, but it is a real window.
- **The two restart sessions share a Node process** in the test suite, as described above.
- **No access control.** "Private by default" is expressed in the model but enforced nowhere.
- **`EmbeddingRetriever` is a shape with no body**, and the hybrid weights are unchosen.
- **No relevance feedback.** Nothing records which retrieved context actually helped, which is the signal
  that would let the weights be learned rather than guessed.
- **`domain-forum`, `logic-bridge` and `apps/` remain placeholders.**

---

## Deferred

Unchanged from Phase 0 and still out of scope: Neo4j, RDF, quadstore, vector database, MeTTa, Lean,
Datalog, multi-agent systems, recommendation, automatic curriculum or KG generation, reputation,
leaderboards, governance, federation, payments, production databases, auth, leaderboards and a full
frontend. No real model is connected — only the scripted mock — and that ordering remains deliberate.

---

## Recommended next step

**Implement `EmbeddingRetriever`, folding a similarity term into the existing score while keeping the
other signals.**

This is the highest-value next slice because it is the only place where the loop is architecturally
complete but practically fragile. `retrieve()` works, is deterministic, is tested, and now sits behind a
seam — but it matches words, and a real learner will not phrase a question with the words they wrote their
own claim in. Everything downstream inherits that, including the central claim of the project.

The slice is bounded and the shape is already decided: an embedding port in the Adapters layer, a
similarity term folded into `scoreOf`, the other three signals retained, `RetrievalResult` unchanged, and
the critical-loop test upgraded to ask a **paraphrased** question — which is a strictly stronger
assertion than the current one.

Second: **encryption at rest**, which Phase 1 made newly relevant by putting a personal cognitive graph on
disk in plain text.

Third: **`domain-forum`**, as the real test of "one graph, many views" by reusing `concept`, `question`,
`claim` and `thought` verbatim.
