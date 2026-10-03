# 0002 — Event-sourced cognitive state

## Context

The project's central object is not "what does this user know" but "what does this user currently
understand, why, and how did that change". The v0 acceptance criteria require two things a
conventional model makes impossible:

- expressing "I used to understand it this way, and now I understand it differently" — which
  needs the earlier understanding to remain readable, not as an approximation of it but exactly
  as it was;
- making a later interaction differ _because_ of what was stored earlier — which needs the
  change itself to be an addressable fact, not just an overwritten field.

The natural model — a `Claim` row with a `confidence` column and a `status` column, updated in
place — satisfies neither. It keeps the current value and discards the trajectory, and a
`status = "understood"` write silently destroys the reason the user's answer should change next
time.

## Decision

Understanding is modelled as an **append-only, immutable, traceable, branchable log of state
events**. Current state is _derived_, never stored as the source of truth.

- A `StateEvent` records that **one actor's** understanding of **one node** changed, carrying
  only the dimensions that actually moved.
- The log supports `commit`, `fork`, `history`, `reduce`, `stateOf` and `branchAncestry`. There
  is **no update and no delete**.
- `reduce(events)` — exported as `foldEvents` — is the definition of current state. Engram caches
  the result for `stateOf`, and that cache may be discarded and rebuilt at any time.
- Understanding is a small set of independent axes, each with its own vocabulary declared by a
  registered dimension definition: `exposure`, `confidence`, `evidence`, `articulation`,
  `transfer`, `conflict`, `source`. There is deliberately **no single `mastery` number**.
- State belongs to the **actor**, not to the node. `StateEvent.actorId` is a separate axis from
  a node's authorship, so an agent may author a node while a human's understanding of it moves.
- Removal is a **revoke** (`state:revoked`, hidden from queries by default). Physical deletion is
  reserved for privacy, legal compliance and account deletion.

## Alternatives

**Mutable fields with an audit log alongside.** The fastest route to a first demo, and familiar.
Rejected because the audit log becomes a second-class citizen: reads use the mutable field,
writes may or may not update the log, and the two drift. The project's premise is that the
trajectory _is_ the data.

**Occasionally-consistent snapshots.** Store periodic snapshots plus a delta. Rejected because it
answers a performance question the project does not have yet. If replay ever becomes the
bottleneck, a snapshot is a cache in front of `reduce` and changes nothing about the model.

**A single scalar `mastery` per concept.** Compact, easy to visualise and rank. Rejected because
it is exactly the loss this project exists to prevent: confident-but-inarticulate and
fluent-but-conflicted are different situations requiring different responses, and one number
makes them identical.

**State stored on the node.** Simpler reads, one lookup for "how well is this understood".
Rejected as both a correctness and a privacy failure: one person's history would become another
person's starting point.

**Full snapshots per event** (each event carries the complete dimension set rather than a delta).
Simpler reduction and no risk of a lost update. Rejected because the history stops reading as a
story of changes; a reader has to diff consecutive snapshots to see what actually moved, and the
log grows with the number of dimensions rather than the number of changes.

## Consequences

- "I used to understand it this way" is a direct query, and the earlier event stays byte-for-byte
  unchanged. This is Test A.
- Every read of current state goes through `reduce`, so state can never drift from history.
  Caching is safe because invalidation is unambiguous: appending to a subject invalidates that
  subject.
- The log grows monotonically. Acceptable for v0, and the honest answer is that compaction is a
  future problem to solve with snapshots, not a reason to overwrite history now.
- `history()` must merge every open end of an actor's paths, because a forked subject has more
  than one tip. Reduction therefore handles a branching history rather than a single chain.
- Illegal changes are refused at the boundary instead of being repaired later: an unregistered
  dimension, a level outside the declared vocabulary, or an event that records nothing all throw.
- Callers must supply time and ids through a `Clock` and an `IdFactory`, so a history is
  replayable and tests produce byte-stable output.
