# @episteme/app-learn

The Learn interaction surface: a place where a learner actually uses the cognitive graph instead of
reading about it.

```bash
pnpm learn        # terminal
pnpm learn:web    # local web surface at http://127.0.0.1:4321
```

Both run the same loop, over the same graph file, through the same `LearnSession`.

## The loop

```text
1. ask a question in your own words
2. see which of your own prior understanding was retrieved — and WHY, signal by signal
3. record how well you understand one of those things
4. ask again
```

The fourth step is the point. Before anything is recorded the answer has to establish the ground; after,
it starts from what you said you understood. The interface shows the two answers side by side, so the
change is a comparison rather than a claim.

## Why this exists

Phases 0–2 proved the machinery: append-only history, actor isolation, fork lineage, persistence, restart
recovery, and paraphrased retrieval. Every one of those was demonstrated by a test or a printed narrative.
None of them was ever _used_.

That gap matters because the remaining unknowns are not architectural. Whether retrieval helps when the
questions are real, whether `RelevantContext` is the right shape for a real model, and whether the
cognitive signals reflect anything a learner recognises — none of those can be answered by more backend
work. They need a surface.

## What it deliberately is not

- **No account, no login.** There is no identity layer, and this app does not pretend otherwise. It is a
  single-user local tool.
- **No LLM.** The responder is the deterministic stand-in from `@episteme/domain-learn`. It branches in
  three structurally different ways depending on what the learner has recorded, which is enough to show the
  loop working and to keep the test suite reproducible. Swapping in a real model means implementing
  `CognitiveAgent`; nothing here would change.
- **No framework, no bundler.** The web surface is `node:http` plus one HTML file with plain DOM. The
  project's own claim is that it runs with no database, no model and no frontend toolchain, and adding a
  build step to demonstrate that would undercut it.
- **No teaching.** It retrieves, records and answers. It does not decide what you should learn next — that
  would be an application's job, and probably a different one.

## The agent cannot write

Recording understanding goes through `LearnSession.record()`, which commits a `StateEvent` authored by the
human. The method takes no actor parameter, so there is no way to name a different author — a surface that
accepted one would be one refactor away from letting the agent write the learner's understanding. Core's
`core/ai-cannot-author-state` guard rejects a non-human author independently, and a test asserts both.

## What the interface shows, and why

**Every reason is a contribution that actually produced the ranking**, not a reconstruction. The ranked
entries carry their `SignalContribution`s through `RelevantContext.ranked`, computed by the same retrieval
call that produced the order displayed. A view that fetched reasons separately could show an explanation
that disagrees with the list next to it.

**The weights are displayed.** A learner can see that `semantic=0.5` and `recency=0.05`, which makes the
ranking checkable instead of authoritative. Showing the model is the honest version of "we used AI to rank
this".

**Nothing-recorded is shown as nothing-recorded.** `summary` is `''` when the learner has recorded nothing,
and the badge says so, because "the system found nothing relevant" and "the system found nothing" are
different problems with different fixes.

## Layout

| File                   | Contents                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `src/session.ts`       | `LearnSession` — open, ask, record, add a node, list, flush. Shared by both surfaces |
| `src/cli.ts`           | the terminal surface, including the command table                                    |
| `src/server.ts`        | the HTTP surface and its JSON API                                                    |
| `src/serve.ts`         | starts the web surface and prints where it is                                        |
| `src/seed.ts`          | the starting topic, so a learner does not face an empty graph                        |
| `public/index.html`    | the web interface: one file, no build step                                           |
| `scripts/drive-ui.mjs` | drives the page over the DevTools protocol (see below)                               |

## Two defects the surface found

Both were invisible to every existing test, because both are about _using_ the thing rather than about its
semantics.

**The evidence command was named `why`.** So `why is order hard for attention` — the most natural way
anyone would phrase that question — was parsed as the command plus an argument, and the question was
silently discarded. The command is now `explain`, and `RESERVED_WORDS` names the words that must never
become commands, with a test that asks every one of them as a question.

**Generated node ids were label slugs truncated mid-word**, producing
`node_0_self_attention_cannot_tell_which_word_ca`, which the learner was then asked to type to record their
understanding. Ids are now `claim_1`, `concept_3`, and references resolve by unambiguous prefix.

## Verifying the interface

```bash
pnpm learn:web                                   # in one terminal
node apps/learn/scripts/drive-ui.mjs             # in another
```

The script drives the real page over the Chrome DevTools protocol — ask, record, ask again — and writes a
screenshot after each step. A screenshot of a static page proves it renders; it does not prove a learner can
use it. This does.

**Note:** the script asserts that recording changes the answer, so it must run against a graph where that
particular understanding is not already recorded. Point the server at a fresh file first:

```bash
EPISTEME_FILE=/tmp/fresh.jsonl pnpm learn:web
```

Otherwise the second `low` is not a change, and the comparison correctly does not appear — which looks like
a failure and is not.

## Deleting and recomputing

Nothing here is load-bearing except the JSONL file. Deleting it starts a fresh graph; the seeded topic is
re-added on the next open, and no understanding you recorded is recoverable — which is the correct
consequence of deleting the source of truth.
