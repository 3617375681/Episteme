# @episteme/example-learn-session

The v0 closed loop, end to end, printed as a narrative.

```bash
pnpm demo          # from the repo root
# or:
pnpm --filter @episteme/example-learn-session demo
```

## What it demonstrates

```text
User asks a question
        ↓
AI guides exploration
        ↓
User forms / modifies a Claim
        ↓
StateEvent generated
        ↓
Learner Graph changes
        ↓
User leaves
        ↓
User returns later
        ↓
System retrieves relevant cognitive state
        ↓
AI response changes because of previous understanding
```

Seven steps:

1. The learner asks why a Transformer needs positional encoding; the claim hangs off a `concept`.
2. A raw chat transcript exists as a `draft` and is deliberately **not** understanding yet.
3. The learner states a `claim` and records six axes of understanding — and there is no mastery score.
4. A later session asks again: the agent is handed a workspace showing `confidence=low`,
   `evidence=none`, and can only advise distrusting it.
5. The exploration moves the understanding: `evidence=reproduced`, `confidence=high`. The earlier
   event is still readable exactly as it was.
6. A second direction opens from that point via `fork`, recorded as a new branch that inherits
   everything understood before it.
7. The same question, same agent, same code — and a different answer, because the graph remembered.

## Why it is deterministic

The demo runs on a fixed clock (`createFixedClock`) and a scripted agent
(`MockCognitiveAgent`), so the output is identical on every run. Step 7 is only meaningful because
the agent cannot have produced its answer by luck: it answers _from_ the workspace it is handed, and
the printed workspace shows that history was in it.

## Layout

| File          | Contents                                                      |
| ------------- | ------------------------------------------------------------- |
| `src/demo.ts` | `runDemo()`, `buildWorkspace()`, `formatDemo()`, `stateKey()` |
| `src/main.ts` | Prints the demo                                               |

`buildWorkspace` is the privacy boundary in miniature: an agent receives a projection plus the
actor's own state, keyed per node, never the store. `tests/northstar.test.ts` imports `runDemo` and
`buildWorkspace` directly, so the runnable example and the acceptance test cannot drift apart.

## Note

Run `pnpm typecheck` (or `pnpm build`) before `pnpm test` after editing this package — Vitest
resolves `@episteme/*` through each package's `dist/`.
