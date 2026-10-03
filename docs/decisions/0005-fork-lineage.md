# 0005 — Fork lineage

## Context

A required v0 capability is `fork(historyNode)`: continuing an exploration from a point in the
past, without disturbing it. The v0 acceptance criteria ask for "two different paths from the
same earlier understanding", which means one point in history must be able to originate more than
one line of inquiry.

This is why interaction history cannot be an append-only chat message list. But "make it a DAG"
is not yet a decision: a DAG needs a precise definition of what a fork _is_, or the first
implementation tends to let one event acquire two `parent` pointers. That is expressible, but it
forces every reader — reduction, projection, the future UI — to handle a merge case that this
project has no use for.

## Decision

**An event records its predecessor and, separately, the point a path was cut from.**

- `parent` — the previous event _on the same branch_, i.e. within the same linear path.
- `forkedFrom` — the event this branch was cut from, set on a branch's first event.
- `predecessorOf(event) = event.parent ?? event.forkedFrom` — one predecessor function, so a
  single `reduce` folds an entire lineage across branch boundaries without special-casing
  branches anywhere else.

**A fork's first event carries `forkedFrom` and no `parent`.** It begins a new path rather than
continuing one. `parent` therefore never has two writers for the same event, and no event ever
has two parents.

**Any number of paths may be cut from one point.** `fork` refuses only when the chosen event
already has a _linear_ continuation (`parent`), because that would make a single path both
continue and re-split, leaving the actor's own history ambiguous.

**A commit on a fork inherits.** `parent` on a new commit is the branch's own last event. The
inheritance that matters is in the _dimensions_: `reduce` walks `predecessorOf`, so a commit on a
fresh branch is folded on top of everything the origin already contained. Recording a conflict on
a fork does not silently discard the confidence and evidence learned before it.

**Open ends are events nothing continues.** `tips()` / `#openEndsOf` count _both_ `parent` and
`forkedFrom` as continuations. Counting forks as continuations is what stops a point that has
already been branched from being branched again, while still letting one point originate several
paths: the first fork consumes the open end, and the second fork targets the sibling branch it
created.

**One branch is current per actor.** A branch that another branch descends from is closed. An
actor with more than one open branch must name one explicitly; an actor who has never committed
opens a branch on first use.

## Alternatives

**Two `parent` pointers (a true merge-able DAG).** More general, and would support merging two
lines of inquiry back together. Rejected for v0 because no requirement needs merging yet, and
every reader would have to handle it from the start. Synthesis across branches is already
expressible as a `Synthesis` node with `synthesizes` edges, which is closer to what the domain
actually means.

**Fork by copying the events up to the fork point.** Makes each branch an independent, fully
self-contained chain, so reduction needs no cross-branch walk. Rejected because it duplicates
history: a correction to a shared ancestor would have to be applied to every copy, and "these two
paths came from the same origin" would become a convention rather than a fact.

**Fork in place with a branch label on subsequent events only.** Lighter on the event shape.
Rejected because the fork point would then be implied by branch metadata rather than recorded on
the event, so an event could not answer "where did this line split off" on its own.

**Require forking only from the actor's current tip.** Simple, and it removes the multi-fork case
entirely. Rejected because it fails Test B directly: "from the same old understanding I later
went two ways" is a required capability, so one point must be able to originate several paths.

**Set `parent = forkedFrom` on a branch's first event.** Tempting, and it removes the need for
`predecessorOf`. Rejected because it makes the fork point look linearly continued while it is
actually open for further branching, so the first fork would block the second.

## Consequences

- Test B holds: two forks from one event both remain open ends with the same recorded origin.
- Reduction is one function with one traversal rule, and it spans branches without a special case.
- `forkedFrom` is redundant with `parent` on a branch's first event. That duplication is
  deliberate: `parent` answers "what came before on this path" and `forkedFrom` answers "where did
  this inquiry split off", and collapsing them was tried and rejected above.
- A branch with no events has no tip, so a commit onto an empty branch produces an event with no
  `parent`. Not reachable through `fork` (which always creates an event) and not currently
  exercised; if it becomes reachable, that commit needs to seed itself from the branch's origin.
- A fork's event is reachable from its origin's open-end computation, so history reads as one
  merged chronological sequence across all open ends. That is the correct input for `reduce`, but
  a caller wanting a single narrative must pass `from` or `branchId`.
