# 0005 — Fork lineage

## Context

A required capability is `fork(historyNode)`: continuing an exploration from a point in the past
without disturbing it. The acceptance criteria ask for "two different paths from the same earlier
understanding", which means one point in history must be able to originate more than one line of
inquiry, and this is why interaction history cannot be an append-only chat message list.

An earlier implementation refused to fork an event that already had a later continuation. It read
"from the same old understanding I later went two ways" as satisfied by forking twice from the
actor's _current tip_, and treated a mid-history fork as ambiguous.

Building the demo exposed that this was wrong for the case that matters most:

```text
evt_1  confidence = medium    "positional encoding gives every token an index"
evt_2  confidence = high      "self-attention alone does not encode sequence order"
```

The interesting second question — _could relative position solve this differently?_ — starts from the
**cruder, earlier** understanding, not from the refined one. Refusing `fork(evt_1)` made the central
scenario of the project inexpressible.

Allowing it raised the real design question: what does a branch forked from `evt_1` _know_? If it
reads the ordinary history of the subject, it inherits `evt_2` — the very refinement it forked to get
away from, and the fork would then be a no-op.

## Decision

**A branch is a line of inquiry with its own readable lineage.**

- A `Branch` records `forkPoint` — the event it starts from — alongside `parentBranchId`.
- A branch root's `parent` **is** its fork point, so the branch's own read can reach the understanding
  it started from, while `forkedFrom` records that this is a divergence rather than a continuation.
  `parent` stays a single pointer, never a list, so no event ever has two parents.
- `predecessorOf(event) = event.parent ?? event.forkedFrom` is the one traversal rule that reduction
  and history share, which is what lets a single fold span branch boundaries.
- Reading a named branch **stitches its ancestry explicitly**. `#historyOf` walks `branchAncestry`,
  and each ancestor contributes the prefix ending at the point the next branch down the chain forked
  from it (`from: forkPoint`). Changes made on the original line _after_ the fork point are therefore
  not inherited.
- **`branchId` alone scopes the read.** `#lineageOf(query)` derives the visible branch set from
  `query.branchId ?? query.lineage`, so naming one line of inquiry can never include events recorded
  on a branch that is not its ancestor. Callers do not have to remember to pass `lineage`.
- **Reads are per subject.** A branch holds events for every node its actor has reasoned about, so
  "the tip of the branch" is not the same question as "the tip of this branch _for this node_".
  `#resolveTips` resolves the branch's last event **for the requested target**; conflating them made a
  branch-scoped read pick up another node's event and legitimately find nothing. When a branch holds
  nothing for a subject, the read falls back to the point it forked from, so it reports what was
  inherited rather than nothing at all.
- **`tips` answers two different questions, and they are not a filter apart.**

  ```text
  tips(actorId)          "where did this actor leave off?"        → one end per branch
  tips(actorId, target)  "where did they leave off on this node?" → one end per branch, per subject
  ```

  The second is **not** the first with a target filter applied. Filtering the branch end by subject
  reports nothing whenever the branch's most recent event happens to concern another node — which is the
  opposite of the answer wanted, and precisely the confusion this ADR previously described as fixed when
  only the parameter had been added. `tips(actorId, target)` therefore scans each in-scope branch for its
  most recent event _about that subject_.

  An actor with two lines of inquiry has two open ends; a subject that has not advanced on a branch keeps
  its earlier event as that branch's end for that subject.

- **Any** event may be a fork point. There is no "tip only" rule, and `fork` refuses only an event
  belonging to another actor, because continuing someone else's line would silently adopt their
  reasoning as your own.
- **`fork` moves the actor onto the new branch.** The next `commit` continues the fork rather than the
  branch it was cut from, which is what makes a fork a change of direction rather than a second
  annotation. A caller wanting to advance the original line has to fork back to it explicitly.

## Alternatives

**Keep the tip-only rule.** Simplest, and it makes the actor's history unambiguous. Rejected because
it makes the project's central scenario inexpressible — the demo cannot be written, and the more
interesting question ("what if my earlier, cruder answer were right?") cannot be asked.

**Two parent pointers (a merge-able DAG).** More general, and it would support merging two lines of
inquiry back together. Rejected for v0 because no requirement needs merging, and every reader would
have to handle it from the beginning. Synthesis across branches is already expressible as a
`Synthesis` node with `synthesizes` edges, which is closer to what the domain means.

**Fork by copying the events up to the fork point.** Each branch becomes self-contained, so reading
one needs no cross-branch stitching. Rejected because it duplicates history: a correction to a shared
ancestor would have to be applied to every copy, and "these two paths came from the same origin" would
become a convention rather than a fact.

**Let a forked branch inherit the whole parent branch, up to its current tip.** Simplest read — the
existing backward walk just works. Rejected because the fork then inherits the change it forked to
avoid, which makes going back meaningless.

**Model a line of inquiry as a node in the graph rather than as branch metadata.** More consistent
with "everything is a node", and it would let a branch be tagged, discussed or referenced. Rejected
for now because branch identity is a property of the _history_, not of the knowledge being
represented, and putting it in the graph would mix the two. Revisit if branches need to be
collaborated on.

**Return a merged fold for `stateOf` once an actor has branched.** Keeps the single-argument call
meaningful. Rejected because two lines of inquiry are genuinely two beliefs, and silently merging them
would reintroduce exactly the ambiguity that made the tip-only rule attractive.

## Consequences

- The demo is expressible: fork from `evt_1`, and the new line knows `confidence = medium`, not `high`.
- Reads are per line of inquiry, so "what do I currently understand" is only well defined once a
  branch is named. An application showing an actor's state should name their current branch; the
  unqualified read remains for the single-line case and for history views.
- Reading a named branch is O(ancestry × events on the subject) rather than a single backward walk.
  Fine at v0 scale, and the place to add an index if it ever matters.
- `tips()` counts lines rather than events, so an actor who has branched appears to hold several open
  positions. That is the honest representation, and a view must decide which to surface.
- Retracting an event still hides its effect: a revoked branch root leaves the branch empty, so the
  branch stops being an open end and its parent line becomes readable again.
- Two defects in the first version of this model were found only by tests, and both are fixed above:
  a reverse-in-place bug that reordered the internal event index on every read, and the subject-blind
  tip resolution that made branch-scoped reads silently miss their own events.
