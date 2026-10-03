# 0007 — Semantic retrieval as one signal among several

## Context

Phase 1 left one architectural gap: retrieval matched words. A learner who recorded _"self-attention does not
encode sequence order"_ and later asked _"which word comes first in the input?"_ got nothing, because the two
share no term. Everything downstream of retrieval inherited that, including the project's central claim.

The obvious fix — add embeddings — carries a specific risk for _this_ project. Episteme's reason to exist is
that it stores what a person understands and how that changed. A retriever that ranks on embedding similarity
alone is a vector search over a personal corpus: it would answer "which of my documents is most like this
question" and be deaf to the two things that make the graph worth having — structure, and the learner's own
recorded state. A relevant claim adjacent to a concept just mentioned, or a claim the learner has themselves
flagged as contested, are invisible to a similarity score.

There was also no retrieval seam a second strategy could plug into; `EmbeddingRetriever` existed as a class
that rejected.

## Decision

**Add semantic retrieval behind the existing `Retriever` seam, and make it one weighted signal among five.**

1. **`EmbeddingAdapter`** is a new Core port: `model`, optional `dimensions`, `embed`, optional `embedMany`.
   Provider-neutral. No vector database, no LangChain, no LlamaIndex. Two implementations — a deterministic
   test double in Core, and HTTP adapters (`ollama`, `openai`, `tei`) in `@episteme/embeddings-http` built on
   `fetch`, so the adapters add **no dependency**.

2. **`EmbeddingCache`** is a Core port with an in-memory implementation. Embeddings are **derived data**: they
   may be deleted and recomputed with no loss of user cognition. Entries are keyed by model _and_ text,
   because vectors from two models are incomparable and reusing one for the other would make similarity
   silently meaningless.

3. **`HybridRetriever`** combines five signals — semantic, lexical, graph, cognitive, recency — each
   normalised to `[0, 1]`, each recorded as a `SignalContribution` so a result can explain itself.
   `EmbeddingRetriever` is the _same scoring path_ with the other weights at zero, so the two cannot drift.

4. **Weights are not tuned.** `DEFAULT_HYBRID_WEIGHTS = { semantic: 0.5, lexical: 0.15, graph: 0.15,
cognitive: 0.15, recency: 0.05 }` encodes one requirement: every weight is within a factor of two of every
   other, so no single term decides a ranking alone. That is the invariant expressed as a number. They are
   exposed as a constructor parameter so a caller can isolate a signal, which is how the tests verify each one
   does the work it claims.

5. **Failure is explicit and typed.** `EmbeddingError` distinguishes `unavailable`, `timeout`,
   `provider_error` and `malformed_response`. A retriever never returns an empty result when the backend is
   down, because that reads as "the learner understands nothing" — a different and much worse claim.

6. **`RetrievalResult` is unchanged.** Scores are attached; the shape a caller reads is not. The async
   boundary stays inside retrieval — Core's graph operations remain synchronous.

## Alternatives

**Rank purely on embedding similarity.** Simplest, and what most systems do. Rejected because it discards
signals the graph already has: a question about RoPE reaching a claim about sequence order happens _through
structure_, and the learner's own recorded state is evidence no similarity score can see. It would also make
the project's existing lexical and neighbourhood behaviour a regression rather than a foundation.

**Keep the two retrievers independent.** Less coupling: the embedding retriever scores by similarity and the
hybrid one does something else. Rejected because they would then disagree about candidate filtering, about
which nodes count as matches, and about ordering — and the disagreement would be invisible until it produced a
confusing result.

**A vector database.** The conventional answer at scale. Rejected because at the scale of one person's
cognitive graph a similarity search is a linear scan over a few hundred vectors. It would add infrastructure
the project does not need and a second store to keep consistent, for a problem it does not have yet.

**Ship the real provider first, then the seam.** Prudent-sounding. Rejected because no live provider was
verifiable in this environment (see below), and blocking the architecture on that would have been the wrong
trade: the seam, the failure taxonomy and the scoring model are testable without one.

**An absolute similarity threshold.** The obvious way to suppress noise. **Tried and rejected twice**: a
threshold high enough to exclude hash-collision noise also dropped real paraphrases, and one low enough to keep
them admitted the noise. The working rule has two parts — similarity is _clamped_ rather than rescaled, and the
floor is applied to the query's **strongest** match rather than per node, so one exceptionally strong match
cannot suppress a merely strong one.

**Query rewriting or an LLM reranker.** Would improve retrieval quality. Rejected for now: the graph and state
signals are meant to do that work, and the improvement is not worth making the architecture harder to reason
about at this stage.

**Persist embeddings in the graph file.** Would avoid recomputation across restarts. Rejected because it would
put derived data in the source of truth, which is exactly the distinction Phase 1 established when it refused
to persist reduced state.

## Consequences

- A paraphrased question reaches stored cognition: `tests/paraphrase-critical-loop.test.ts` asserts the lexical
  miss, the semantic hit, the injected context and the changed answer, and that it survives a restart with an
  empty cache.
- Every Phase 0 and Phase 1 guarantee still passes unchanged — append-only history, actor isolation, fork
  ancestry, retraction, projection isolation, persistence, restart recovery.
- `retrieve()` becomes asynchronous, and eight call sites were updated. That is the real cost of a swappable
  strategy.
- The evaluation set (`tests/retrieval-evaluation-fixtures.ts`) exists to make regressions visible, and its
  **unrelated case** — a question with no expected result — found two real defects that the paraphrase case
  could not: hash collisions being read as similarity, and recency alone making a node relevant.
- Weights are explicitly untuned and `SEMANTIC_MATCH_THRESHOLD` is calibrated against the deterministic
  adapter, so both would need revisiting against a real model. Recorded as debt rather than presented as
  settled.
