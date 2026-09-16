# New (simplified) kernel-protocol design — Sept 14, 2026

Written by Claude in response to: "think through the kernel protocol additions suggested by the notes,
and simplify. The fewer changes we have to make to the protocol the better."
The OLD design is `.claude/artifacts/kernel-design-notes.md` section 2–3 (and the verbatim transcript,
turns 1 and 4–5). This document is the NEW design, verbatim as proposed.

---

The notes ask the protocol for four things: analysis, namespace operations, scopes, and snapshots.
I'd cut the delta to one new message pair plus two optional fields on messages that already exist,
and the message pair alone is enough for a first version of both plugins.

**Scopes go.** They exist to isolate branches that rebind the same name. The reactive plugin enforces
one definition per name anyway, and with analysis available the DAG plugin can enforce the same rule,
or at least flag a violation before running. Under the rebind-rather-than-mutate contract, branches
with disjoint definitions in one namespace cannot interfere, which is the model Hex and marimo already
ship. Pluto's fresh-module trick only existed to emulate delete in Julia, so nothing is lost there.
People who need isolation for mutating code get it from the server tier below.

**Snapshot, restore, and clone leave the kernel protocol entirely.** Replay needs nothing from the
kernel. Process-level checkpointing is a jupyter_client provisioner plus a Jupyter Server endpoint,
which is a REST change that touches no kernel message. The language-native tier is the only one that
needs kernel messages, and it is the Python-shaped one. The DAG plugin should code against a
server-level "clone kernel" operation and treat CRIU and replay as two implementations of it.

**namespace_request folds into execute_request.** Delete is always a pre-step of a run: remove what
this cell defined last time, then run it. So it becomes an optional list on the request, applied
before the code. Purging without running, say when a cell is removed, is an execute with empty code
and silent set. Get already exists as user_expressions. Set goes. Mapping JSON onto a language binding
is ambiguous in R, JavaScript, and Julia, which is why papermill keeps per-language translators, and
comms already carry widget-bound values. It comes back only if we later choose value-carrying edges.
Lab already sends the ids of deleted cells in execute_request metadata on the next run, so the
frontend half of "tell the kernel what's gone" has precedent.

**namespace_delta stays, but shrinks.** An optional reply field, present whenever the kernel
advertises it, holding names added and names removed. Both are exact set differences. Rebinding
detection goes. Comparing object identity either keeps old values alive during the run or compares
ids that get recycled, and static analysis already reports which names a cell assigns. The field
checks static analysis against what actually happened, and it gives parser-less kernels such as bash
the defines half of an edge for free.

**analyze_request is the one new message.** Batch of code strings in, positional list out. Per cell:
status, defines, references, and a flag meaning "this cell may touch names I can't see", covering
exec, star imports, non-standard evaluation, and macros. Imports are defines, so there is no separate
list. A single flag replaces graded confidence. I'd put it on the shell channel rather than control.
It then shares the dispatch path of complete and inspect and imposes no threading requirement on
kernel authors. It also stays ordered with executions, which matters when an earlier cell registers a
magic that changes how a later cell parses. Responsiveness during a long run comes from sending it on
a subshell where the kernel has them. ipykernel 7 routes any shell message by its subshell id, so that
works today. In ipykernel the implementation is transform_cell followed by ast or symtable.

```
analyze_request  {"code": ["df = pd.read_csv(path)", "df.head("]}
analyze_reply    {"status": "ok", "cells": [
                   {"status": "ok", "defines": ["df"], "references": ["pd", "path"], "dynamic": false},
                   {"status": "error", "ename": "SyntaxError", "evalue": "..."}]}

execute_request  {...existing..., "namespace_delete": ["df"]}
execute_reply    {...existing..., "namespace_delta": {"added": ["df"], "removed": []}}
```

| | notes (old) | simplified (new) |
|---|---|---|
| new message pairs | 4, plus 4 for snapshots | 1 |
| new optional fields | 2 | 2 |
| feature strings | 4 | 3 |

Three feature strings rather than one, so bash can advertise the delta without analysis and Julia can
advertise analysis without delete. The frontend has to gate on them. ipykernel reads execute fields
with defaults, so an unsupported delete list would be silently ignored, and that is the one failure
that breaks the no-hidden-state promise.

There is a route to zero new message types. ipykernel answers several Jupyter-specific DAP commands on
the control channel with no debug session running, and the debugger's dumpCell command already
carries cell source, so analysis and delete could ride inside debug_request the way inspectVariables
did. I'd use that only as a prototype transport alongside the comm-target route. It ties the feature
to debugger-capable kernels, and reviewers would be right to call it a category slip.

Verified in local checkouts: Lab services parse supported_features and gate on the subshell string
(packages/services/src/kernel/default.ts:688); ipykernel evaluates user_expressions right after the
run (ipkernel.py:499), which is where the pre-run delete and the delta slot in; the session-free DAP
handlers are listed at debugger.py:320 (debugInfo, inspectVariables, richInspectVariables, modules,
copyToGlobals); dumpCell is a started-session handler.

---

## Summary of the OLD design (from kernel-design-notes.md §2–3) for quick reference

1. `analyze_request`/`analyze_reply`: per cell `defines`, `references`, `imports`, `confidence` /
   `has_unknown_references`; served on the CONTROL channel (like debug_request) to avoid queuing
   behind a busy shell; optional `namespace_delta: {added, rebound, removed}` on `execute_reply`.
2. `namespace_request` with `delete: [names]` and `set: {name: json}`; no get (user_expressions).
3. Scopes: `create_scope(parent) → scope_id`, `execute_request.scope`, `drop_scope`; child = shallow
   copy of / lookup chain onto parent; reactive-grade branch isolation; composes with subshells.
4. Heavier optional tier: `snapshot_request`/`snapshot_reply` on SHELL (ordered with executions),
   `restore_request`, list, delete; manifest + opaque blob; fidelity/uncaptured reporting; tiers:
   replay, process-level CRIU/DMTCP via provisioner, language-native (dill/Kishu, R save.image,
   Julia Serialization, JVM CRaC); "clone kernel" as better primitive for fan-out.
5. Reuse: stop_on_error, silent/store_history, cellId metadata, comms, DAP variables,
   supported_features (JEP 92).
6. Decide first: edge = "B runs after A in same namespace" (start here) vs "B receives A's value".
