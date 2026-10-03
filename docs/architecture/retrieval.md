# Retrieval

How a later interaction finds the understanding that should shape it. Read
[projection.md](projection.md) first: projection answers "show me this area", retrieval answers "what
is relevant to this question".

## The seam

```ts
interface Retriever {
  readonly name: string
  readonly description: string
  retrieve(query: RetrieveQuery): Promise<RetrievalResult>
}
```

`RetrieveQuery` extends Core's `RetrievalQuery`, so the structural part — text, anchors, tags, node
types, depth, limit — is unchanged. `RetrievalResult` is Core's and stays stable: a retriever may
attach scores, never change the shape a caller reads.

`retrieve()` is asynchronous even though the lexical implementation has nothing to await. A vector
index or a remote service would be, and a synchronous signature would have to be broken later.

| Implementation          | Status                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| `LexicalGraphRetriever` | the default; deterministic, no model, no embeddings                      |
| `EmbeddingRetriever`    | **designed, not implemented** — it rejects rather than returning nothing |

Rejecting rather than returning an empty result is deliberate. A caller that forgot to configure
embeddings would otherwise silently receive no context and conclude the learner understands nothing,
which is a different and much worse claim than "this retriever is not available".

## What the lexical retriever does

1. **Term extraction.** Lowercased, split on non-alphanumerics, stop-worded, de-duplicated in
   first-seen order. The stop list is deliberately short: an aggressive one would drop words like
   `not` and `does`, and this system cares about _how_ something is understood, where such words often
   distinguish a claim from its opposite.
2. **Matching.** Terms are looked for in a node's label, tags and id. An anchor outranks a label match,
   which outranks a tag match.
3. **Traversal.** `depth` hops outward from the matches, undirected. This is what lets a question about
   "RoPE" surface the claim RoPE was built to answer, even though the question never names it.
4. **Gating.** Drafts and revoked nodes never appear as matches, via the same query path as every other
   node lookup.

Deterministic by construction: the same question over the same graph returns the same thing in the same
order. That is what lets the critical loop be _asserted_ in a test rather than demonstrated by hand.

## The gap, stated plainly

The lexical retriever matches **words**. A learner who asks

```text
why does order information survive in RoPE?
```

will not reach a claim phrased as

```text
self-attention alone does not encode sequence order
```

There is no shared term. Everything downstream of retrieval inherits this: the agent's answer, and
therefore the whole claim the project rests on. This is the single biggest weakness in the v0 loop, and
it is why replacing it is the recommended next slice.

## Hybrid scoring: the design

A future retriever should combine several relevance signals, of which semantic similarity is only one:

```text
score(node) =
    w_semantic   · semantic similarity      (embedding distance; the part that is missing today)
  + w_graph      · graph proximity          (hops from a matched node; already computed)
  + w_state      · actor-state relevance    (what this actor recorded, and how strongly)
  + w_recency    · recency                  (when it was recorded)
```

### Why graph proximity belongs

A node adjacent to something the learner just asked about is relevant _because of the structure_, not
because of any textual resemblance. The lexical retriever already exploits this through `depth`, and it
is the reason a question about RoPE can reach a claim about sequence order at all. A pure vector
retriever would discard that signal, which is strictly worse than what exists now.

### Why actor-state relevance belongs

Episteme knows something a generic retriever cannot: **this actor's own recorded understanding**.
Several distinct signals live there, and they point in different directions:

- A node the actor holds with **high confidence** is worth retrieving when the question builds on it,
  because the answer can start from it rather than re-deriving it.
- A node with an **open conflict** is worth retrieving _even when the question does not name it_,
  because the agent must not build on a position the learner has themselves marked as contested.
- A node with **low articulation and high confidence** is the most valuable of all: the learner thinks
  they understand it and cannot say it, which is precisely what a scaffold should surface.

No similarity score can see any of this. It is the reason Episteme should not become ordinary vector
RAG over a personal corpus.

### Why recency belongs, and why it is weakest

Recently recorded understanding is more likely to be what the learner has in mind. It is a weak signal
on its own — a correction made a year ago may still be the most relevant thing there is — so it exists
mainly as a tie-break that makes the order total and reproducible. It already plays that role.

## Weights

**Not chosen yet, on purpose.** Picking weights before there is a semantic term to weight would be
guessing at a number that cannot be validated, and a table of made-up constants is worse than an
explicit "undecided" because it looks considered.

What can be said now is the shape the weights must have:

- **No single signal may dominate.** If `w_semantic` is an order of magnitude above the rest, the graph
  and state terms are decoration and the system is vector RAG with extra steps.
- **Actor state should be able to override similarity.** A confidently-held open conflict is not a
  ranking preference; it is a constraint on what the agent may build on.
- **The result must stay explainable.** A learner is entitled to know why their own past understanding
  surfaced. `RetrievedNode.matchedTerms` is empty for a semantic match, so the semantic implementation
  owes the result some account of itself — at minimum the score and which signals contributed — rather
  than a bare number.

The natural way to make this tunable later is a weight vector on the query, with the default in one
place. What must not happen is an implicit constant buried inside a scoring function.

## Where the join happens

`retrieveWith(retriever, graph, log, question, options)` is the one place a retrieval result is joined
to an actor's understanding, producing `RelevantContext`:

```ts
context.nodes // the relevant part of the graph, ranked
context.known // what THIS actor understands about those nodes
context.summary // one readable line; '' when nothing is recorded
context.retriever // which strategy produced it
```

Two details are deliberate:

- **`summary` is `''` when nothing is recorded**, not a sentence saying so. "Nothing" must be
  distinguishable from "something" _as data_, because a responder branches on it. The display form is
  `contextSummary()`, so a human-readable phrase can never be mistaken for recorded understanding.
- **`toAgentContext` passes the concrete understanding in `detail`**, not only a rendered string, so a
  responder can branch on _which_ understanding exists instead of pattern-matching prose it wrote a
  moment earlier.

Actor isolation is inherited, not re-implemented: the join reads `log.stateOf(node, actorId)`, so a
concept stays shared while the understanding of it stays private.

## The loop this makes possible

```text
question
   ↓  retriever.retrieve()   relevant part of the graph, ranked
   ↓  stateOf()              what this actor understands about it
   ↓  respond(input, ctx)    an answer conditioned on that
   ↓  commit / fork          the understanding changes
   ↓  next question          a different context, and so a different answer
```

`tests/critical-loop.test.ts` holds the agent and the code fixed and varies only the stored history, so
a different answer is attributable to what was remembered. `tests/restart-recovery.test.ts` is the same
proof across a process boundary.

## Known limitations

- Retrieval is lexical, as above.
- Full scan with in-memory adjacency; the storage port is where an index belongs.
- No relevance feedback: nothing records which retrieved context actually helped. That is the signal
  that would let the weights be learned rather than guessed.
- `EmbeddingRetriever` is a shape with no body.
