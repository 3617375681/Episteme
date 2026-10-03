# 0004 — Domain extension boundary

## Context

Learn is the first scene, not the project. Forum, Research, skill acquisition and collaborative
inquiry are all expected to share the same graph, and the whole reason Core exists is so that a
thought written while learning can be contributed to a discussion without conversion.

That only holds if a scene can add what it needs **without Core learning the scene's vocabulary**.
The failure mode is concrete: the moment `Claim` or `mastery` appears in Core, the ontology is
tied to one product, and every later scene inherits the assumptions of the first.

There is a second, subtler pressure. Some rules genuinely cannot live in Core — "a Thought must
carry a source and at least one anchor" is meaningless to a graph that has never heard of a
Thought — yet leaving them to an application means every application reimplements them, and they
diverge.

## Decision

Scenes are **domain packs**, and a pack is the only sanctioned way to add vocabulary.

A pack registers, through the registries rather than through Core's code:

- node types (`registerNodeType`)
- edge types (`registerEdgeType`), including allowed source and target node types
- state dimensions (`registerStateDimension`), each with its own legal levels
- tag namespaces (`registerTagNamespace`)
- guards (`registerGuard`)
- projections and query operators, through the same registry pattern

`defineDomainPack` builds a pack from declarative definitions, so the common case — a pack that
only adds vocabulary — needs no imperative code at all. `applyDomainPacks` applies packs in order,
and every registration uses `registerIfAbsent`, so two packs that share a vocabulary compose
instead of conflicting.

`packages/domain-learn` is the reference implementation. It contributes `concept`, `question`,
`claim`, `evidence`, `thought` and `synthesis`; fifteen edge types; the seven axes of learner state;
and two guards:

- `learn/thought-requires-source` — a `thought` or `synthesis` must carry a source and at least one
  anchor. A `claim` deliberately must not: it is an assertion the learner holds and is grounded
  later by `supports` and `contradicts`, so requiring an anchor up front would block the ordinary
  case of forming a position before finding evidence for it.
- `learn/anchors-must-exist` — every id in `anchors` must already exist.

The rule that decides where something goes, asked in order:

1. Is it a graph primitive? → Core
2. Is it a cross-application domain rule? → Domain pack
3. Otherwise → Application

A domain-level retrieval convenience (`retrieveRelevantContext`) also lives in the pack, because it
joins Core's structural retrieval to _learner_ state. Core's `retrieve` finds the relevant part of
the graph; the pack is what knows that "relevant" has anything to do with what the learner
understands.

## Alternatives

**Put domain vocabulary in Core.** Simplest — one package, no registration ceremony, no
`registerIfAbsent` subtlety. Rejected because it makes the second scene impossible to build without
either reusing Learn's words in a context they do not fit or forking Core.

**A pack is a directory of code with a conventional export.** Less machinery than a registry.
Rejected because nothing would force a type to be registered before use, and an unregistered type is
invisible to validation, projection and every future migration. The registry is what turns "please
follow the convention" into "this cannot be written".

**Separate graphs per domain, with a shared node-id space.** Maximum isolation. Rejected because the
project's premise is that Learn and Forum read the _same_ objects; separate graphs would need a
conversion step, which is exactly the lossy boundary this design exists to avoid.

**Guards as Core branches (`if (node.type === 'thought')`).** Fewer moving parts. Rejected because
Core would then contain Learn's rule, which is the thing being avoided, and a second domain could
not add a rule at all.

**A plugin framework with lifecycle hooks, dependency resolution and a capability graph.** The
general solution. Rejected for now: `defineDomainPack` covers every requirement today, and the
specified failure mode of premature frameworks is real. If pack ordering ever needs to be computed
rather than declared, that is the moment to revisit.

## Consequences

- Adding a scene needs no Core change. `Forum` is expected to reuse `concept`, `question`, `claim`
  and `thought` verbatim, which is the real test of this decision.
- Vocabulary gains ceremony: a new kind of content needs a registered type before it can be stored.
  That is the point.
- A pack can only add, never weaken. It cannot make an unregistered type legal or bypass
  `validateMutation`, so the invariants stay in one place.
- Domain rules that must apply to _every_ mutation belong in Core's structural validation rather
  than in a pack, because a pack that forgot to register them would be a back door. The AI-ownership
  rule is the current example: it is structural, not opt-in.
- Two packs sharing a type must agree on its definition. `registerIfAbsent` returns the existing
  registration rather than overwriting it, so the first pack wins and the conflict is silent rather
  than destructive — acceptable now, and the thing to check if packs ever become third-party.
