# @episteme/example-persistent-session

Two sessions over one file: understanding is recorded, the instance is dropped, and a fresh instance
answers differently because the memory came from disk.

```bash
pnpm demo:persistent        # from the repo root
# or:
pnpm --filter @episteme/example-persistent-session demo
```

## What it shows

```text
Session 1
  the question, before anything is recorded
    → the agent has nothing to build on (usedContext=false)

  the learner forms an understanding and records it
    → StateEvent evt_1, confidence=high
    → fork evt_2 on a second line of inquiry

  writing to disk and stopping
    → the event history and the graph are on disk

Session 2   (a new instance, built from the file)
  reloaded events, reduced state, restored lineage
    → confidence=high, conflict=open, branch br_1 → br_2, fork point evt_1

  the same question, answered from the restored understanding
    → the agent sees an unresolved conflict and refuses to build on it (usedContext=true)

  the difference is the point
    → identical response? false
```

The last line is the claim: _same question, same agent, same code — the memory came from disk._

## Why the answer changes shape, not just wording

`learnerResponder` branches in three structurally different ways: with no recorded understanding it must
establish the ground; with understanding it starts from it; with an **unresolved conflict** it refuses to
build on a position the learner has themselves marked as contested. In this scenario session 1 forked a
second line recording `conflict=open`, so session 2 restores _both_ the confidence and the doubt — and the
agent answers the doubt rather than the confidence.

That is a stronger demonstration than a changed sentence, because the difference is caused by data the
agent was handed rather than by prose it generated.

## Why the sessions are genuinely separate

`runSessionOne` returns only a **file path**. `runSessionTwo` builds its own adapter, graph and event log
from that file, with an empty in-memory state. Nothing is carried between them except the bytes on disk.

Honest limitation: both sessions run inside one Node process here, because a demo that spawns a child
process is harder to read. The separation that matters is that the _instance_ is rebuilt from disk, and
`node dist/main.js` genuinely starts a new process each time you run it.
`tests/restart-recovery.test.ts` makes the same point with a second adapter object and no shared memory
at all.

## Layout

| File          | Contents                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `src/demo.ts` | `runSessionOne`, `runSessionTwo`, `runPersistentDemo`, `formatPersistentDemo` |
| `src/main.ts` | Prints the demo                                                               |

`runPersistentDemo` uses a temporary directory and removes it afterwards, so running the demo does not
leave files behind. To keep one, call `runSessionOne('/some/path/graph.jsonl')` and then
`runSessionTwo` on the same path.
