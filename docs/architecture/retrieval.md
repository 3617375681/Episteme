# Retrieval

How a later interaction finds the understanding that should shape it. Read
[projection.md](projection.md) for the surrounding view model.

```text
question
   ↓  retriever.retrieve()   the relevant part of the graph, ranked, with reasons
   ↓  stateOf()              what THIS actor understands about it
   ↓  respond(input, ctx)    an answer conditioned on that
   ↓  commit / fork          the understanding changes
   ↓  next question          a different context, and so a different answer
```

## The seam

```ts
interface Retriever {
  readonly name: string
  readonly description: string
  /** Declared so a caller can tell a semantic result from a lexical one without inspecting scores. */
  readonly signals: readonly RankSignal[]
  retrieve(query: RetrieveQuery): Promise<RetrievalResult>
}

type RankSignal = 'semantic' | 'lexical' | 'graph' | 'cognitive' | 'recency'
```

`RetrieveQuery` extends Core's `RetrievalQuery`, so the structural part — text, anchors, tags, node types,
depth, limit — is unchanged. `RetrievalResult` is Core's and **stays stable**: a retriever may attach scores,
never change the shape a caller reads.

`retrieve()` is asynchronous because embeddings are. A synchronous signature would have to be broken later,
and the async boundary is deliberately confined to retrieval: Core's graph operations stay simple and
synchronous.

| Implementation          | Signals        | Status                                            |
| ----------------------- | -------------- | ------------------------------------------------- |
| `LexicalGraphRetriever` | lexical, graph | the Phase 0 behaviour, unchanged, behind the seam |
| `EmbeddingRetriever`    | semantic       | cosine similarity only, via an adapter            |
| `HybridRetriever`       | all five       | **the one a product should use**                  |

`EmbeddingRetriever` and `HybridRetriever` share **one scoring path**; the embedding-only retriever is that
path with every other weight at zero. Writing the ranking twice is how the two would drift apart.

## The embedding port

```ts
interface EmbeddingAdapter {
  readonly model: string
  readonly dimensions?: number
  embed(text: string): Promise<Vector>
  embedMany?(texts: readonly string[]): Promise<readonly Vector[]>
}
```

Provider-neutral, no vector database, no LangChain or LlamaIndex. Two implementations:

- **`DeterministicEmbeddingAdapter`** (Core) — a hashed bag of tokens with a small hand-written lexicon. See
  its limits below; it is a test double, not a model.
- **`HttpEmbeddingAdapter`** (`@episteme/embeddings-http`) — Ollama, OpenAI-compatible and
  text-embeddings-inference shapes over `fetch`, with no dependency. See its README for the provider
  integration seam and the known gap: **no live provider was verifiable in this environment**.

`EmbeddingRetriever` does **not** silently return an empty result when the backend is unavailable. It throws
a typed `EmbeddingError` whose `kind` distinguishes unreachable, timeout, provider error and malformed
response. An empty result would read as "the learner understands nothing", which is a different and much
worse claim than "the provider is down".

## The embedding cache is derived data

`EmbeddingCache` is a port; `InMemoryEmbeddingCache` is the implementation. **Embeddings can be deleted and
recomputed with no loss of user cognition** — the event history and the graph are the source of truth, and
nothing here may be treated as one. That distinction is why there is no vector database: at the scale of one
person's cognitive graph, similarity is a linear scan.

Entries are keyed by **model as well as text**. Two models produce incomparable vectors, and reusing one
model's vector for another would make similarity silently meaningless while still returning plausible
results — the worst kind of retrieval bug. A test asserts that a fresh process with an empty cache retrieves
correctly, which is exactly what a restart looks like.

## The signals

### Semantic

Cosine similarity between the question and each candidate. Two decisions here were both wrong first:

- **Clamped, not rescaled.** `(cos + 1) / 2` looks harmless and is not: unrelated documents score around `0`
  cosine, which it inflates to `0.5`, so a relevant match at `0.34` and an irrelevant one at `0.08` arrive as
  `0.67` and `0.54`. The difference the signal exists to express is compressed into a few hundredths, and the
  ranking is then decided by whichever other signal has the wider range — which is how a hybrid retriever
  silently stops being semantic. In the first working version, semantic contributed **under two percent** of
  the total score. Clamping keeps "not similar" near zero.
- **A floor on the query, not on nodes.** Below `SEMANTIC_MATCH_THRESHOLD` the query's strongest match is not
  meaningful, and the signal contributes nothing at all. A per-node relative threshold was tried and is
  wrong: it lets one exceptionally strong match suppress a merely strong one, which is how a relevant claim
  gets pushed out by a slightly better relative of itself.

The threshold is calibrated against measured values, not guessed: a genuine paraphrase scores `0.34`–`0.51`,
and an unrelated question peaks at `0.14`.

### Lexical

The fraction of query terms found in the label, tags and id, with a label hit weighted double. Measured by the
same `matchedTermsIn` Core's lexical retriever uses, because two definitions of "does this match" would drift.
Lexical matching is a **prefilter only when no semantic signal will run** — with embeddings it would discard
the wordless-but-relevant candidates that embeddings exist to find.

An incidental match is excluded: a query term that appears in a node without the node being _about_ it must
not be reported as semantic relevance. There was a case of exactly this — a claim about token indices carried
the tag `state:active`, the question contained "capital", and sharing the token "active" was enough to look
like meaning.

### Graph

Hop distance from a lexically matched seed, decaying as `1 / (1 + hops)`; a seed scores `1`. This is what lets
a question about RoPE reach a claim about sequence order even when the question never names it, and it is the
signal a pure vector retriever would **lose**.

### Cognitive

The actor's own recorded state, and the reason Episteme should not become ordinary vector RAG. It is
deliberately simple and deliberately _not_ a pedagogical model. It answers one question: does this node
deserve to be in front of the learner again?

| State                                     | Contribution | Why                                                                    |
| ----------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| an open conflict                          | strongest    | the agent must not build on a position the learner marked as contested |
| low confidence                            | moderate     | the ground is not solid, so re-surfacing it is useful                  |
| low articulation                          | moderate     | the learner believes it and cannot say it — what a scaffold is for     |
| high confidence **and** high articulation | negative     | nothing to add by showing it again                                     |

That last row is the point: the signal is not "strongly held is relevant" but almost the opposite.

### Recency

Position within the observed candidate span, not `createdAt / now` — otherwise every node in a graph written
in one sitting scores almost `1` and the signal consumes weight while carrying no information. It is the
smallest weight because it is genuinely the weakest: a correction made a year ago may still be the most
relevant thing there is. It exists mainly to make the ordering total.

**Recency is never a reason on its own.** A node whose only contribution is recency has nothing to do with the
question and is not reported. Without that rule, an unrelated question returned a claim scoring exactly the
minimum floor, on recency alone.

## Hybrid scoring

```text
score(node) = w_semantic  · semantic similarity
            + w_lexical   · lexical overlap
            + w_graph     · graph proximity
            + w_cognitive · actor-state relevance
            + w_recency   · recency
```

Every signal returns `[0, 1]` so the weighted sum stays interpretable, and **every contribution is recorded**
in `SignalContribution`, so a result can explain itself. That matters more than it sounds: a semantic match
has no `matchedTerms`, so for the paraphrase case the score _is_ the explanation, and a learner is entitled to
know why their own past understanding surfaced.

### Weights

```ts
DEFAULT_HYBRID_WEIGHTS = {
  semantic: 0.5,
  lexical: 0.15,
  graph: 0.15,
  cognitive: 0.15,
  recency: 0.05,
}
```

**Not tuned, and not presented as optimal.** They encode one requirement: every weight is within a factor of
two of every other, so no single term can decide a ranking alone. That is the project's invariant — _semantic
similarity must not become the only meaningful signal_ — expressed as a number. A semantic weight an order of
magnitude above the rest would be vector RAG with extra steps.

They were adjusted once, and the reason is instructive: the first arrangement had `semantic: 0.35` and
`recency: 0.1`, and the scale bug described above meant recency decided the paraphrase case. The weights were
not the problem; the scale was. Fixing the scale and rebalancing so semantic can do its job was the fix, and
the evaluation set is what made the difference visible.

A weight vector is a parameter on `HybridRetriever`, so a caller can isolate one signal — which is how the
tests assert that each does the work it claims.

## Candidate filtering

Every retriever filters candidates the same way, or two strategies would answer subtly different questions and
could not be compared:

- **Drafts are excluded.** Raw material is not understanding.
- **Retracted nodes are excluded**, through the same query path as every other lookup.
- **Node types are honoured.** Traversal still passes _through_ a node of an unwanted type, so a two-hop
  relation stays reachable, but the node is not reported.

`matches` and `neighbors` are a statement about **how** a node was found: a strong semantic hit is a `match`,
because reporting it as a neighbour would misdescribe why it is there. A node never appears in both groups.
Every entry names its node, its origin, its score and its terms, so "which subject is this about" is
answerable from the result alone — the branch-versus-subject ambiguity that has caused several bugs in this
codebase is not permitted to reappear as a third interpretation.

## Where the join happens

`retrieveWith(retriever, graph, log, question, options)` is the one place a retrieval result is joined to an
actor's understanding, producing `RelevantContext`:

```ts
context.nodes // the relevant part of the graph, ranked
context.known // what THIS actor understands about those nodes
context.summary // one readable line; '' when nothing is recorded
context.retriever // which strategy produced it
```

Two details are deliberate:

- **`summary` is `''` when nothing is recorded**, not a sentence saying so. "Nothing" must be distinguishable
  from "something" _as data_, because a responder branches on it. The display form is `contextSummary()`.
- **`toAgentContext` passes the concrete understanding in `detail`**, not only a rendered string, so a
  responder can branch on _which_ understanding exists instead of pattern-matching prose it wrote a moment
  earlier.

Actor isolation is inherited, not re-implemented: the join reads `log.stateOf(node, actorId)`, so a concept
stays shared while the understanding of it stays private. A test asserts that one actor's paraphrase does not
retrieve another actor's state.

## The proof

`tests/paraphrase-critical-loop.test.ts` is the acceptance test:

```text
stored:    "Self-attention does not encode sequence order."
later:     "Which word comes first in the input?"
lexical:   (nothing retrieved)          ← asserted, not assumed
semantic:  the claim, ranked first
answer:    differs from the no-memory control, and survives a restart
```

The paraphrase shares **no word** with the claim, and an earlier draft that used "why can't attention tell
which token came first?" was rejected precisely because `attention` is a substring of `self-attention` — the
lexical signal genuinely fired, so the test would have proved nothing about meaning. That is recorded in the
test's own comments, because the distinction is easy to lose.

## Evaluation set and hard negatives

`tests/retrieval-evaluation-fixtures.ts` is a small deterministic set: six cases over eleven claims, all
tagged with the same topic so the structural signals cannot do the discriminating. Each case names its
expected nodes and its **hard negatives**, and a case passes only when every expected node is retrieved and no
hard negative outranks the worst-placed expected node. Optimising for recall alone would be gamed by returning
everything; cognition is only useful if the right piece arrives ahead of the noise.

The two cases that matter most are mirrors:

| Query                                    | Must win                  | Must lose                 |
| ---------------------------------------- | ------------------------- | ------------------------- |
| "Which word comes first in the input?"   | the sequence-order claim  | the attention-heads claim |
| "How many attention heads should I use?" | the attention-heads claim | the sequence-order claim  |

Both share the word "attention" with the graph. A retriever that ranks on that word passes one and fails the
other, which is why one case alone would not have caught it.

**The unrelated case is what found both real defects.** "What is the capital of Portugal?" has no expected
result, and asserting that turned up:

1. **Hash collisions were being read as similarity.** At 256 dimensions, unrelated texts shared buckets and
   scored `0.34` — indistinguishable from a true paraphrase — because the query contained the word "capital".
   Widening to 8192 dimensions is what made the signal mean anything, and the separation is now asserted
   directly (`relevant > 3 × irrelevant`, `irrelevant < 0.1`) so it cannot regress silently.
2. **Recency alone could make a node relevant**, which is how a claim scoring exactly the minimum floor
   appeared for a question about Portugal.

Neither was visible from the paraphrase case. The lesson is recorded here rather than in a commit message: a
case with _nothing_ expected is the cheapest way to find a retriever that returns too much.

## The deterministic adapter's limits

`DeterministicEmbeddingAdapter` is not a language model and does not pretend to be one. It is a hashed bag of
tokens plus a finite, readable lexicon that folds related terms onto a shared token — `sequence`/`order`/
`first`/`arrangement` land together because the lexicon says so, not because anything was learned.

It exists so the pipeline can be tested without a provider, and so the acceptance test is _stronger_: a real
model might have matched anyway, and the claim under test is that a paraphrased question reaches stored
cognition through the embedding path. Anything outside the lexicon is compared by the tokens it literally
shares. It is not a substitute for a real provider, and the demo says so in its own output.

## Known limitations

- **No live provider was verified** in this environment, as above.
- **Weights are untuned** and were not validated against a benchmark.
- **The deterministic adapter's lexicon is finite**; a paraphrase outside it will not be found.
- **Full scan.** `retrieve()` scores every candidate against every signal, and embeddings are computed per
  node on first use. Fine at the scale of one person's graph; an index is where it would go.
- **No relevance feedback**: nothing records which retrieved context actually helped, which is the signal that
  would let the weights be learned rather than guessed.
- **No query rewriting or reranking.** Both were excluded deliberately; the graph and state signals are meant
  to do that work, and adding a model to fix retrieval quality would make the architecture harder to reason
  about than the quality is worth at this stage.
- **`SEMANTIC_MATCH_THRESHOLD` is calibrated against the deterministic adapter.** A real model's similarity
  distribution differs, so the threshold — and the match/neighbour boundary — would need revisiting with one.
