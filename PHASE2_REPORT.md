# Episteme — Phase 2 Report

## Goal

> Make Episteme able to recover a learner's prior understanding even when the learner asks the same
> underlying question using different wording.

**Status: achieved.** Semantic retrieval is implemented behind the existing seam, combined with graph and
cognitive signals, and the strongest test proves the whole chain without relying on lexical overlap.

```text
pnpm install          ✓
pnpm typecheck        ✓
pnpm lint             ✓
pnpm test             ✓   117 tests across 17 files
pnpm demo             ✓   Phase 0: the cognitive loop
pnpm demo:persistent  ✓   Phase 1: across a process restart
pnpm demo:semantic    ✓   Phase 2: a paraphrase reaching stored cognition
```

Every Phase 0 and Phase 1 guarantee still passes unchanged.

---

## Embedding architecture

Three layers, each replaceable, none of them a dependency.

```text
Core                          @episteme/embeddings-http
────────────────────────      ──────────────────────────────────────────
EmbeddingAdapter         ←──  HttpEmbeddingAdapter   (ollama | openai | tei)
EmbeddingCache           ←──  (in-memory; the default and usually the right one)
DeterministicEmbeddingAdapter (test double, in Core)
```

| Port | Shape | Why |
| --- | --- | --- |
| `EmbeddingAdapter` | `model`, `dimensions?`, `embed`, `embedMany?` | provider-neutral; `embedMany` optional because not every provider batches |
| `EmbeddingCache` | `get`, `set`, `size`, `clear` | derived data, never source of truth |

**No vector database, no LangChain, no LlamaIndex, no native build step.** The HTTP adapters use `fetch`,
for the same reason Phase 1 chose JSONL over SQLite: a learner should not need a toolchain between them and
their own cognition. At the scale of one person's cognitive graph, similarity is a linear scan.

### The cache is derived data, and that is enforced

Embeddings can be deleted and recomputed with **no loss of user cognition**. Two consequences are encoded
rather than merely intended:

- Entries are keyed by **model as well as text**. Vectors from two models are incomparable, and reusing one
  model's vector for another would make similarity silently meaningless while still returning plausible
  results — the worst kind of retrieval bug.
- A test asserts that a fresh process with an **empty cache** retrieves correctly, which is exactly what a
  restart looks like. Nothing in the persistence format was changed to accommodate embeddings.

### Failure is explicit and typed

`EmbeddingError` carries a `kind`: `unavailable`, `timeout`, `provider_error`, `malformed_response`. A
retriever never returns an empty result when the backend is down, because an empty result reads as "the
learner understands nothing" — a different and much worse claim than "the provider is down".

`malformed_response` exists for the dangerous case: a provider answering `200` with an error object would
otherwise yield a zero-length vector, and a zero-length vector makes every similarity `0`, which is
indistinguishable from "nothing is relevant".

---

## Retriever implementations

| Implementation | Signals | Status |
| --- | --- | --- |
| `LexicalGraphRetriever` | lexical, graph | Phase 0 behaviour, unchanged, behind the seam |
| `EmbeddingRetriever` | semantic | cosine similarity only, via an adapter |
| `HybridRetriever` | all five | the one a product should use |

`EmbeddingRetriever` and `HybridRetriever` share **one scoring path**; the embedding-only retriever is that
path with every other weight at zero. Writing the ranking twice is how the two would drift apart.

`Retriever` gained `signals` and `description`, so a caller can tell a semantic result from a lexical one
without inspecting scores, and a hybrid implementation cannot quietly drop a signal it claims to combine.
`RetrievalResult` is **unchanged** — scores are attached, the shape a caller reads is not.

`retrieve()` is asynchronous and the async boundary stays inside retrieval: Core's graph operations remain
synchronous. Eight call sites gained an `await`.

---

## Hybrid scoring

```text
score(node) = w_semantic  · semantic similarity
            + w_lexical   · lexical overlap
            + w_graph     · graph proximity
            + w_cognitive · actor-state relevance
            + w_recency   · recency
```

```ts
DEFAULT_HYBRID_WEIGHTS = { semantic: 0.5, lexical: 0.15, graph: 0.15, cognitive: 0.15, recency: 0.05 }
```

**Not tuned, and not presented as optimal.** Every weight is within a factor of two of every other, which
encodes the invariant — *semantic similarity must not become the only meaningful signal* — as a number. A
semantic weight an order of magnitude above the rest would be vector RAG with extra steps.

Every contribution is recorded in a `SignalContribution`, so a result can explain itself. That matters most
for the paraphrase case, where the semantic match has no `matchedTerms` and the score *is* the explanation.

### Three defects found by making the signals comparable

These are the substance of the phase, and none was visible from the paraphrase case alone.

**1. The similarity scale made the semantic signal decide nothing.** `(cos + 1) / 2` maps an unrelated pair
(~`0` cosine) to `0.5`, so a relevant match at `0.34` and an irrelevant one at `0.08` arrived as `0.67` and
`0.54`. The difference the signal exists to express was compressed into a few hundredths, and recency then
decided the ranking. In the first working version, semantic contributed **under two percent** of the total
score — a hybrid retriever that had silently stopped being semantic. Clamping keeps "not similar" near zero.

**2. Hash collisions were being read as similarity.** With a 256-dimension hash space, `"What is the capital
of Portugal?"` scored `0.34` against a claim about token indices — identical to a true paraphrase — because
unrelated tokens shared buckets. Widening to 8192 dimensions is what made the signal mean anything. The
separation is now asserted directly: `relevant > 3 × irrelevant`, `irrelevant < 0.1`.

**3. Recency alone could make a node relevant.** A node whose only contribution was recency was reported,
which is how a claim scoring exactly the minimum floor appeared for a question about Portugal. Recency is
now never a reason on its own.

The floor rule also had to be corrected: a **per-node** relative threshold lets one exceptionally strong
match suppress a merely strong one, pushing a relevant claim out in favour of a slightly better relative of
itself. The floor belongs on the **query**, judged from its strongest match, and reuses the match threshold —
two floors a hair apart would be a distinction nobody could reason about.

### The invariant, checked by construction

A test isolates each signal by zeroing the others, and asserts that each does the work it claims:

- semantic alone finds the claim and ranks it first
- lexical alone provably **misses** it
- the cognitive signal alone moves a node with an open conflict ahead of one that is merely held
- with no conflict recorded, the same two nodes are indistinguishable on that signal — so the preference
  came from the state, not from insertion order

---

## The acceptance test

`tests/paraphrase-critical-loop.test.ts`:

```text
stored:    "Self-attention does not encode sequence order."
later:     "Which word comes first in the input?"
lexical:   (nothing retrieved)          ← asserted, not assumed
semantic:  the claim, ranked first
answer:    differs from the no-memory control, and survives a restart
```

Both halves are asserted: **the lexical retriever provably misses**, and the semantic path succeeds. Without
the first assertion the second would prove nothing.

The paraphrase shares **no word** with the claim. An earlier draft used *"why can't attention tell which
token came first?"* and was rejected because `attention` is a substring of `self-attention` — the lexical
signal genuinely fired, so the test would have proved nothing about meaning. That reasoning is recorded in
the test's own comments, because the distinction is easy to lose and was lost once already.

Also asserted: the join reaches this actor's state for that node, one actor's paraphrase does not retrieve
another actor's state, and a fresh process with an empty embedding cache still retrieves correctly.

---

## Evaluation fixtures and hard negatives

`tests/retrieval-evaluation-fixtures.ts` — six cases, eleven claims, all tagged with the same topic so the
structural signals cannot discriminate. Each case names its expected nodes **and its hard negatives**; a case
passes only when every expected node is retrieved and no hard negative outranks the worst-placed expected
node. Recall alone would be gamed by returning everything.

The two cases that matter most are mirrors:

| Query | Must win | Must lose |
| --- | --- | --- |
| "Which word comes first in the input?" | the sequence-order claim | the attention-heads claim |
| "How many attention heads should I use?" | the attention-heads claim | the sequence-order claim |

Both share the word "attention" with the graph, so a retriever ranking on that word passes one and fails the
other. One case alone would not have caught it.

**The unrelated case found the two real defects.** `"What is the capital of Portugal?"` has no expected
result, and asserting that turned up the collision noise and the recency-only relevance above. This is the
phase's most transferable lesson: a case with *nothing* expected is the cheapest way to find a retriever
that returns too much.

---

## Demo

`pnpm demo:semantic` prints, in order:

```text
Stored cognition                      "Self-attention does not encode sequence order."
Later question, in different words    "Which word comes first in the input?"
Lexical retrieval                     (nothing retrieved)          signals: lexical, graph
Hybrid retrieval                      1. Self-attention does not encode sequence order.  [score 0.259,
                                         matched: — (meaning)]
                                        2. Positional Encoding      [score 0.158]
                                        3. Self-Attention           [score 0.110]
                                        4. How many attention heads should I use? [0.090]
No-memory answer                      re-derives the groundwork (usedContext=false)
Memory-aware answer                   continues from it (usedContext=true)
The difference is the point           identical response? false
After a restart                       paraphrase still works, from disk; cache started empty
```

The ranked output is visible on purpose, with terms shown per entry — so a reader can see that the winning
claim matched on **meaning** (`matched: —`) while the hard negative, which shares the word "attention", did
not win.

---

## Architecture decisions

`docs/decisions/0007-semantic-retrieval.md` records the decision and, more usefully, the alternatives:
ranking purely on similarity (rejected: discards structure and state), keeping the retrievers independent
(rejected: they would drift), a vector database (rejected: linear scan is right at this scale), shipping the
real provider first (rejected: would block architecture on an unverifiable dependency), an absolute
similarity threshold (**tried and rejected twice**), query rewriting or an LLM reranker (rejected: the graph
and state signals are meant to do that work), and persisting embeddings in the graph file (rejected: derived
data must not enter the source of truth).

`docs/architecture/retrieval.md` was rewritten around the five signals, the evaluation set, and why the
weights are not tuned.

---

## A documentation claim that was false, caught by the new invariant test

The spec asked for the branch-versus-subject distinction to be strengthened, since it had caused several
subtle bugs. Writing that test found a **third instance, still live**:

`tips(actorId, target)` was documented — in `docs/decisions/0005-fork-lineage.md`, in the Phase 1 report, and
in its own commit message — as now subject-aware. It was not. The commit added the `target` parameter and
left the body resolving the branch-global tip, then filtered the result afterwards. So `tips(actor, target)`
returned **nothing** whenever a branch's most recent event concerned another node — the exact opposite of the
answer wanted, and the same class of bug Phase 1 believed it had fixed.

Branch-scoped *reads* had been resolved correctly (`#lastOnBranchFor`); the querying helper had not.
`tips()` now scans each branch for its most recent event about the requested subject, and
`tests/branch-subject-invariant.test.ts` states the distinction as assertions — including that
`tips(actor)` and `tips(actor, target)` are **not a filter apart**, which is precisely the confusion.

`docs/decisions/0005-fork-lineage.md` and `PHASE1_REPORT.md` were corrected, and the correction left visible
rather than quietly rewritten: *documentation asserting a fix is not evidence that the fix exists.*

---

## Tests

117 tests across 17 files, all passing.

| File | Covers |
| --- | --- |
| `event-history`, `state-reduction`, `fork-ancestry`, `actor-isolation` | Phase 0 semantics, unchanged |
| `guards` | one validation path; AI cannot author state |
| `projection` | one graph, many views |
| `northstar`, `critical-loop` | the project's central claims |
| `retrieval`, `revocation-and-query` | lexical retrieval, retraction |
| `serialization` | the versioned persistence contract |
| `restart-recovery`, `persistence-integrity` | Phase 1 guarantees, unchanged |
| **`paraphrase-critical-loop`** | the Phase 2 acceptance test |
| **`retrieval-evaluation`** | the six-case set, hard negatives, determinism, signal isolation |
| **`branch-subject-invariant`** | branch vs subject vs actor, and that a result names its subject |
| **`embeddings-http`** | the provider contract and its failure taxonomy |

---

## Known limitations

- **No live embedding provider was verified here.** The local Ollama build (0.30.5) rejects `/api/embed`
  (*"start it with `--embeddings`"*) and `ollama serve --help` shows no such flag; its five installed models
  are chat models, and ~5 GiB free made pulling an embedding model unreliable. The request/response shapes,
  the failure taxonomy and the guards are tested against a stub; an end-to-end run against a real model is
  not. This is the phase's main unverified surface.
- **The deterministic adapter is not a language model.** A hashed bag of tokens plus a finite lexicon. A
  paraphrase outside that lexicon will not be found, and the demo says so in its own output. It makes the
  acceptance test *stronger* (a real model might have matched anyway), but it is not production retrieval.
- **`SEMANTIC_MATCH_THRESHOLD` is calibrated against that adapter.** A real model's similarity distribution
  differs, so the threshold and the match/neighbour boundary would need revisiting with one.
- **Weights are untuned** and were not validated against a benchmark.
- **No relevance feedback**: nothing records which retrieved context actually helped, which is the signal
  that would let the weights be learned rather than guessed.
- **Full scan.** Every candidate is scored against every signal, embeddings computed per node on first use.
  Fine at this scale; an index is where it would go.
- **No query rewriting or reranking**, deliberately.
- **The evaluation set is tiny and hand-written**, so it catches regressions, not quality.

## Security and privacy debt

Unchanged from Phase 1, and Phase 2 did not add to it:

- **No encryption at rest.** The cognitive graph is plain text JSONL. Still the most serious gap.
- **No access control or policy layer.** "Private by default" is expressed in the model and enforced
  nowhere; actor isolation is a correctness property of the code, not a security boundary.
- **Embeddings are new derived personal data.** They are cached in memory only, and the cache is
  non-authoritative by design — but a real provider means text leaves the process, and a local model file is
  itself sensitive. Neither is addressed.

## Deferred

Still out of scope, as specified: vector database, Pinecone, Milvus, Weaviate, Neo4j, LangChain, LlamaIndex,
reranker LLM, query-rewriting agent, multi-agent retrieval, automatic ontology generation, full frontend,
forum domain, cloud deployment, authentication, encryption implementation.

---

## Recommended next step

**Stop adding infrastructure. Build the minimal real Learn interaction surface.**

Phase 2 closed the last architectural gap in the loop: a learner's own words can now reach them again from a
different phrasing, and that understanding changes what the system says next. The chain is complete end to
end — question → retrieval → actor state → agent context → changed answer → new event → persistence →
restart → retrieval again — and it is proven by tests, not by narrative.

What has never been tested is whether any of it is *usable*. Everything so far is a library, a CLI demo, and
a mock agent whose responses are template strings. Three concrete unknowns cannot be answered by more
backend architecture:

1. **Does the retrieval actually help when the questions are real?** Every paraphrase so far was written by
   me to be findable. A learner asking their own question is the only test that matters, and it needs a
   surface to be asked in.
2. **Is `RelevantContext` the right shape for a real agent?** It was designed against a mock. A real model
   receiving `summary` and `detail` would show quickly whether the context is sufficient, too lossy, or too
   verbose.
3. **Do the cognitive signals reflect anything a learner recognises?** "Low articulation with some
   confidence" is a guess about what deserves resurfacing. Only a person can confirm it.

The smallest slice that answers them: a **local, single-user learn surface** — a terminal or minimal page
where a learner types a question, sees which prior understanding was retrieved *and why* (the contributions
are already recorded), records a state change, and gets an answer built on it. No auth, no accounts, no
deployment, no frontend framework, and **no new infrastructure** — it composes what exists through
`@episteme/sdk`.

That is also where the honest limits would surface fastest: the deterministic adapter would show its ceiling
immediately, which is the right trigger for wiring a real provider rather than a reason to build more
scaffolding first.

Second, and only if the surface works: **encryption at rest**, now the oldest unfixed debt.

Third: **verify a real embedding provider** on a machine that has one, revisiting `SEMANTIC_MATCH_THRESHOLD`
against a real similarity distribution.
