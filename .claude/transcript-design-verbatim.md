# jupyter-dag design conversation — verbatim transcript

Chat with Claude, September 10–11, 2026. This is the design portion of the
conversation, reproduced verbatim (citation markup removed; web searches the
assistant ran between turns are not shown). It covers kernel state
save/restore, the DAG-view frontend library, the talk framing, the minimal
kernel-protocol features for reactivity plus DAGs, and the overlap with
language-server support.

---

## Turn 1

**User (Thursday, September 10, 2026):**

I want to design a DAG feature for jupyterlab that allows a user to string the input cells of a notebook into one or more DAGs, arranged however the user wants. For a DAG that has several output paths, it would be very useful to be able to save and restore the state of the notebook kernel right after the last unbranched step. For Python it's clear enough how to perform this kind of save and restore of state (`pickle(globals())` + some stuff). But the Jupyter project is all about language universalism; a cool feature that only works for python is not sufficient for inclusion into Jupyter/lab core.  What I would really want is to build save_state and restore_state functionality directly into the Jupyter kernel itself. How should I go about implementing these features into the Jupyter kernel? In particular, is there any universal way to represent the state of the interpreter underlying the kernel, independent of interpreter/kernel language? Maybe something along the lines of a way to serialize/deserialize vars + functions + classes?

**Claude:**

Short version: there is no language-independent representation of interpreter state, and "vars + functions + classes" can't be turned into one. What *can* be universal is the contract: an optional, protocol-level snapshot/restore feature that each kernel implements with whatever its language offers, that reports honestly what it couldn't capture, and that degrades to re-execution for kernels that can't do it at all. That's the shape a JEP for this would need, and it's how the debugger and subshells got in.

**Why a serialization format can't be the universal layer**

A running interpreter's state isn't a set of named values. It's an object graph with shared references and cycles, closures over mutable cells, class objects whose identity matters to already-created instances, mutated module state (monkey-patches, `sys.path`, RNG state), plus things that don't live in the heap at all: open files, sockets, DB connections, threads, subprocesses, GPU allocations, native-library internals. Any format expressive enough for the first group is by construction that language's own heap format (pickle, R's rds, Julia's `Serialization`), and nothing captures the second group. "Vars + functions + classes" is a source-level view; once you write it down, what you have is a script that *reconstructs* state, which is the replay approach rather than a snapshot. Even in Python, `pickle(globals())` is the weak version of this: modules, generators, C-backed objects without `__reduce__`, `__main__`-defined classes without dill all fail, and pickling variables one at a time silently breaks aliasing between them (dump the namespace as one object to preserve sharing).

**What the universal layer should be: an optional feature in the messaging protocol**

JEP 92 added a `supported_features` list to `kernel_info_reply` so a kernel can advertise which optional features it supports without coupling that to the protocol version, and subshells are specified as exactly such an optional feature. So the proposal is a feature like `"kernel state snapshots"` consisting of:

- `snapshot_request`/`snapshot_reply` on the *shell* channel, not control, because you want it ordered relative to `execute_request`s ("after cell 7, before cell 8"). The reply carries `snapshot_id`, `fidelity: full | partial`, and `uncaptured: [{name, reason}]`.
- `restore_request`/`restore_reply`, plus list and delete.
- A language-neutral *manifest*: kernelspec, `language_info`, execution count at snapshot time, size, storage backend, captured names with type strings, uncaptured names. The payload is an opaque blob tagged with a format id (`python/dill`, `r/rds`, `criu`). Same pattern as `display_data`: universal envelope, typed opaque content. Blobs stay kernel-side and are referenced by id; they can be gigabytes and don't belong in a ZMQ message.

The semantics are where reviewers will push, so nail them down: snapshot only when quiescent (with subshells, all of them idle); comms are invalidated on restore (widget state lives half in the frontend, so the kernel should close all comms before restoring); whether `In`/`Out`/execution count are restored or kept monotonic; restore never undoes side effects outside the process; partial fidelity is always reported, never silently degraded.

**Three implementation tiers behind that contract**

1. *Replay — every kernel, zero kernel changes.* The DAG extension knows the prefix path; "restore" is restart plus re-execute. Correct by construction modulo nondeterminism and side effects. This is the floor, and the fallback for partial snapshots.

2. *Process-level — language-agnostic, Linux only.* CRIU (or DMTCP, which needs no root) images the whole kernel process: heap, threads, fds. The important architectural point is that this needs no cooperation from the kernel, so it belongs in a `KernelProvisioner` in `jupyter_client` plus a jupyter_server endpoint, and it then works for xeus-cling, IJulia, IRkernel, anything. Wrinkles: the kernel binds its ZMQ ports, so on restore it rebinds and the frontend's connect-side sockets reconnect on their own, but established TCP connections must be dropped at restore (CRIU's `--tcp-close`); GPU contexts need NVIDIA's `cuda-checkpoint` in concert with CRIU; images are machine-specific; macOS and Windows have nothing comparable. A cheap cousin is `fork()` at the branch point with the child kept stopped, but ZMQ isn't fork-safe and only the forking thread survives, so that variant does need kernel cooperation.

3. *Language-native heap serialization — per kernel.* For Python, dill/cloudpickle over `user_ns` with per-object fallback is essentially what Kishu does: it checkpoints variable and code state of IPython sessions, supports branching states via Git-like commits and checkouts, and relies on cell replay to reconstruct unpicklable objects such as generators. ElasticNotebook goes further and computes a replication plan choosing store-vs-recompute per variable from dependencies, runtimes and sizes. That hybrid — serialize what you can, replay what you can't — is the right model for tier 3, and the `uncaptured` field in the reply is what lets the frontend drive the replay half. R's `save.image()` is unusually complete for this. Julia can serialize `Main`'s bindings but restoring type definitions into a live session is awkward enough that restore-into-fresh-process is the sane mode. JVM kernels have CRaC. C++ via cling has nothing but tier 2.

Useful data point when arguing for tier 3 over tier 2: Kishu's evaluation found incremental CRIU comparable on checkpoint time but up to 36× slower on checkout, because a process image can't be restored selectively.

**A DAG-specific reframing: clone, don't restore**

For fan-out, save/restore is the sequential formulation of a parallel problem. Restoring one CRIU image twice on different ports gives you two kernels, one per branch, running concurrently. A `clone_kernel` provisioner operation is a more natural primitive for a DAG than snapshot/restore, and replay emulates it trivially (start a second kernel, replay the prefix). I'd design the extension against "clone" and treat snapshot/restore as one implementation of it.

**How to proceed**

Prototype without touching the protocol: a comm target in ipykernel (the same mechanism ipywidgets uses) for the messages above, your JupyterLab extension, and a CRIU provisioner for the language-agnostic tier. Once the semantics hold up on two kernels (ipykernel plus a xeus kernel is the usual bar), open a pre-proposal issue in the enhancement-proposals repo, which is the least formal stage and where feasibility and scope get discussed; the submission guidelines and JEP template are in the same repo. For the DAG semantics themselves, look at how marimo, Pluto.jl and dfnotebook/ipyflow define cell dependencies — all language-specific for the same reasons snapshots are, which is a useful argument to have ready when the JEP review asks why the core feature is a contract rather than a format.

---

## Turn 2

**User (Friday, September 11, 2026):**

For the UI component of jupyter-dag, I want to make an alternate view of a notebook in which each cell widget (input+output) is an arrangeable node that can be freely wired to any other cell, a la litegraph.js. litegraph.js is no longer maintained (aside from a "fork" maintained as a subdirectory in the comfyui-frontend project: https://github.com/Comfy-Org/ComfyUI_frontend/tree/main/src/lib/litegraph), so what is the alternative that exists that has functionality that maps most closely to my vision for a notebook "DAG view"? In other words, what exists that I can use that would involve writing the least custom code myself? Would using the comfyui flavored "fork" of litegraph.js be viable?

**Claude:**

Use React Flow (`@xyflow/react`). It's the closest fit to "each cell is a draggable, wirable node" and the option with the least custom code, because the one non-negotiable property of your nodes — they must be real DOM, hosting a CodeMirror editor and an output area with arbitrary HTML and widgets — is React Flow's native model rather than something you bolt on.

**Why the ComfyUI litegraph fork isn't viable as a dependency**

Comfy-Org/litegraph.js was archived on August 5, 2025 and folded into the ComfyUI Frontend monorepo, with the stated reasoning that it was only ever used by ComfyUI and keeping it separate created unnecessary complexity; the merge was meant to enable faster development and bigger architectural refactoring. That is the maintainers telling you it's an internal module, not a library: no package boundary, no semver, and refactors driven by ComfyUI's needs. The import path changed from `@comfyorg/litegraph` to `@/lib/litegraph` inside ComfyUI, and the npm package is frozen at the last pre-merge release.

The deeper problem is that litegraph draws nodes on a Canvas2D. A Jupyter cell can't be canvas-drawn, so you'd overlay DOM elements positioned and scaled over the canvas — ComfyUI's DOM-widget trick — and fight z-order, zoom scaling and event routing for every editor and output. ComfyUI itself has concluded that's a dead end: Nodes 2.0 moves their node framework from the litegraph canvas to Vue.js, because Canvas2D and litegraph now impose significant constraints on interface capabilities and custom node interoperability. There's also licensing: ComfyUI_frontend is GPL-3.0. The litegraph subtree was MIT as a standalone repo and may still carry its own license file (I couldn't fetch the directory to check), but pulling code out of a GPL repo into a BSD-ecosystem JupyterLab extension is a review conversation you don't want. Treat the fork as a reference for interaction details — slot rendering, link routing, reroutes, groups — not as a dependency.

**Why React Flow specifically**

It's MIT-licensed, and nodes are simply React components; the current release line is 12.x and it's still being published actively. JupyterLab ships React and `ReactWidget`, so the graph is an ordinary `ReactWidget` inside a `DocumentWidget` opened on the same `INotebookModel` as the notebook — the DAG view becomes a second view of the same document, the way Lab already opens a notebook as a plain editor. Things you don't write: pan/zoom, drag, multi-select, `Handle`s for ports with `isValidConnection` for typed slots, `NodeResizer`, parent nodes for grouping (your "one or more DAGs"), minimap and controls, ResizeObserver-based node measurement so edges track cells whose height changes when output arrives, and documented dagre/ELK auto-layout recipes.

Custom code you will still write:

- A node component that `Widget.attach`es a Lumino `CodeCell` from `@jupyterlab/cells` into a ref'd div and detaches on unmount, forwarding resize messages. Build those cell widgets from the notebook model's existing cell models so edits sync between views. This is small, but verifying that two `CodeCell` widgets bound to one cell model behave is the first thing to prototype.
- `nodrag`/`nowheel`/`nopan` classes on editor and output areas, so text selection and output scrolling don't move the canvas.
- Persisting positions and wiring into cell metadata.
- Zoom handling: React Flow scales the viewport with a CSS transform. CodeMirror 6 copes with scaled containers, but some outputs (ipywidgets, plotly) size themselves oddly under scale, so clamp `minZoom`/`maxZoom` near 1.

**Runner-up and prior art**

Rete.js v2 is litegraph's conceptual cousin — typed sockets, a dataflow engine — and renders nodes through React, so it also works; but it's more plugin assembly for fewer batteries, and its engine is dead weight when the kernel does the executing. jsPlumb Community and AntV X6 also host DOM nodes but leave you writing more of the editor. Skip anything canvas-only.

Two things worth reading first: marimo's dependency explorer, which shows all cells as an interactive graph and is built on React Flow with ELK layout, and Elyra's pipeline editor, the existing example of a node-graph editor living inside JupyterLab (on IBM's `@elyra/canvas`), which shows the DocumentWidget and persistence plumbing you'll need regardless of graph library.

---

## Turn 3

**User:**

you mention a number of jupyter "successor" notebook projects (marimo, pluto.jl) and I know of some others (hex, databricks). If I wanted to make a 30 minute presentation for a Jupyter conference call "Children of Jupyter", what could I talk about? What interesting new features have popped up in the successor projects? What are the most interesting ways in which the original concept of "ipython notebook" has been reinterpreted?

**Claude:**

Here's a way to build it that gives you a thesis rather than a product tour: Jupyter's real invention wasn't the notebook UI, it was the 2010 split into kernel / wire protocol / document. Every "child" is a different choice about which of those three genes to keep and which to mutate. Some kept the kernel and replaced the document (Colab, VS Code, Deepnote, Datalore); some kept the document idea and replaced the kernel (Pluto, marimo, Livebook, Observable); some kept only the idea (Streamlit, Quadratic). That gives you a family tree slide, and every later section is one gene under mutation.

**Opening (3 min): Jupyter had parents too**

Mathematica notebooks (1988), Maple worksheets, the Sage notebook (2006), and the abandoned 2005 IPython notebook prototypes; then IPython 0.12 in December 2011. The point to land: the notebook idea is old, but the kernel protocol is what made forks cheap. A JupyterCon audience will enjoy Joel Grus's 2018 "I don't like notebooks" as the inciting incident for what follows — Hex's own reactivity announcement says it agrees with Grus that notebook state is broken.

**Act I (6 min): fixing hidden state — the execution model mutates**

This is the biggest reinterpretation: the cell stops being a REPL input and becomes a node in a dataflow graph. Observable (2017) made cells named expressions run in topological order. Pluto (2020) enforced one definition per variable and purges a cell's variables when you delete it. marimo builds a DAG on cells from definitions and references, runs descendants on change, and deliberately doesn't track mutations or attribute assignment; its dependency graph rejects multiple cells defining the same global name because the runtime needs an unambiguous graph. Hex models the project as a DAG behind a linear notebook UI and visualizes it in a Graph view. Show the price of admission too: the single-definition constraint, marimo's lazy mode as the compromise, Polynote's alternative rule that cells only see variables defined above them. Then the Jupyter-native responses: ipyflow and dfnotebook (reactive kernels), and Kishu, which checkpoints session state after each cell and offers Git-like commits and checkouts across branching states.

One detail worth a slide: marimo's file format stores each cell as a function whose signature *is* its incoming edges. The DAG lives in the source, not in a sidecar.

**Act II (4 min): the file is the program — the document mutates**

Pluto notebooks are plain .jl with the package Manifest embedded at the bottom; marimo notebooks are plain .py you can run as a script, import, or test; Livebook is Markdown; Quarto is .qmd; Databricks stores .py with cell separators. Observable Notebooks 2.0 moved to a human-readable HTML-based format and to vanilla JavaScript — the `viewof` dialect that made Observable not-quite-JavaScript is gone, and the open-source Notebook Kit builds static sites from it. Deepnote's new `.deepnote` format goes further and describes the *project*: notebooks, integrations, environment, schedules, published apps, and endpoints in one YAML file. Themes: the environment moves inside the file (Pluto's Manifest, PEP 723 inline metadata plus uv sandboxing in marimo), and outputs move out of it into caches — marimo's WASM export now bundles a runtime cache so published notebooks hydrate outputs without recomputing, letting you share snapshots of runs that can't execute in a browser. Jupytext, MyST and nbformat's stability are Jupyter's side of this argument.

**Act III (4 min): a cell isn't a code cell anymore**

SQL cells everywhere (Hex, Deepnote, Databricks magics, marimo via DuckDB, Datalore, Observable) — the warehouse as a second kernel. Parameter cells as UI: Colab's `#@param` comments, Databricks widgets, Pluto's `@bind`, marimo's `mo.ui`, versus ipywidgets. No-code cells: Hex's explore cells, Deepnote blocks, and marimo's dataframe output with built-in paging, search, filtering and quick charts. Livebook's Smart Cells are the one to demo: a UI that generates real, editable code — code generation as interface, before LLMs. And the unifying counterexample: anywidget, the one widget standard that runs across Jupyter, marimo, VS Code, Colab, Panel and Solara — a child that reunified the family.

**Act IV (4 min): beyond the scroll — space mutates**

Hex's Graph view lets you drag cells anywhere and mirrors selection with the notebook view. Count puts cells on an infinite canvas. Datalore's report builder rearranges cells on a canvas into dashboard-style apps. marimo lets cells sit out of order or across columns, and as of its July 2026 launch week presents notebooks as live interactive slides with a dedicated slide editor. Livebook's branching sections fork evaluation from a point in the document. Quadratic and Python-in-Excel put code cells in a spreadsheet grid. This is your natural spot to demo jupyter-dag: a DAG view of a JupyterLab notebook plus kernel-state snapshots is Jupyter getting branching without giving up the REPL.

**Act V (4 min): notebook → app → API → agent**

Voilà, Streamlit (the rebellion: rerun from the top), marimo run, Hex apps, Deepnote apps and endpoints, Livebook apps. Then the 2025–26 turn: Hex's Notebook Agent traverses the project DAG to find upstream cells and isolate bugs; marimo pair puts coding agents inside a running kernel with access to in-memory data; Jupyter AI 3.0 made JupyterLab a host for external agents via ACP and MCP; Datalore ships an agent skill; Deepnote's CEO framed its open-sourcing as building a standard purpose-built for humans and agents co-authoring. And the twist that the kernel outlived the notebook: ChatGPT's python tool is a stateful Jupyter kernel with no notebook in front of it, and E2B's sandboxes are Jupyter kernels too.

**The graveyard (2 min)**

Beaker, Polynote (effectively dormant), Noteable (closed 2024), Hydrogen with Atom, and this June, Kotlin Notebook — JetBrains sunset it from IDEA 2026.2, saying AI tools changed how developers explore and prototype and many workflows that drove notebook adoption evolved with that shift. Pair that with Deepnote open-sourcing after seven years hosted. Lessons: polyglot-by-autotranslation didn't stick, proprietary dialects didn't stick, closed formats didn't stick; reactivity did, independently, in three ecosystems.

**Close (2 min)**

What Jupyter absorbed back: real-time collaboration, JupyterLite, Jupyter AI, subshells, Jupytext. What it hasn't: reactivity and the file format. Leave the audience with the protocol as the durable gene, `.ipynb` as the contested one, and the linear REPL as the one the children mutate most — then pitch the snapshot JEP from your first question as the way Jupyter gets branches without becoming marimo.

Five one-minute demos would carry it: marimo reactivity on a slider, Pluto deleting a cell and its variables, Livebook a branching section, Hex the Graph view, and jupyter-dag. Verify dates before you present; several of these projects ship monthly.

---

## Turn 4

**User:**

it seems like my idea for jupyter-dag and the concept of reactive notebooks have some overlap in how they might be implemented. In terms of features added to the jupyter kernel, what would be the minimal set of features required to support both in a jupyter appropriate (ie language agnostic) way?

**Claude:**

The overlap is bigger than it looks. Strip both ideas down to what they actually demand from the kernel and they're the same three primitives; the only difference is where the edges come from — inferred by the kernel (reactive) or drawn by the user (jupyter-dag). Everything else — topological scheduling, staleness marking, cycle detection, run modes, persistence of the graph — is frontend or server work and should stay there. The kernel is a REPL with a namespace; the minimal additions are all about making that namespace visible and controllable.

**1. Code analysis: `analyze_request` → defines / references**

Given one or more code strings, return the names each defines and references, plus flags like `confidence` and `has_unknown_references` for when the language can't be sure (Python `exec`/star-imports, R non-standard evaluation and `assign()`, macros in Julia). This is the one language-specific piece reactive notebooks need, and it belongs in the kernel for the same reason `complete_request` and `inspect_request` do: the kernel has the parser. Pluto, marimo, Hex and Observable all do exactly this analysis, each inside their own language-specific runtime.

The nice symmetry with your project: jupyter-dag's manual wiring is the universal fallback for kernels that can't implement this (bash, SQL kernels, cling), and analysis is the optional enhancement that pre-populates or validates the edges. Even a SQL kernel can report `defines: [tables created]`, `references: [tables read]`, which is a good demonstration that the protocol is language-agnostic even when the "language" isn't a programming language.

Worth pairing with a dynamic complement that's nearly free: an optional `namespace_delta: {added, rebound, removed}` field on `execute_reply`, computed by diffing the global names (and object identity where available) before and after execution. That's the ground truth static analysis approximates, it works for languages with no parser support, and it's what ipyflow does inside ipykernel already — so it's proven to be implementable there.

**2. Namespace control: delete (and set)**

"No hidden state" is implemented the same way everywhere: before re-running a cell, delete the names it previously defined, so a renamed variable or a removed cell doesn't leave a ghost binding. Pluto and marimo both do this. jupyter-dag needs it too, the moment a node is removed from a path. So: `namespace_request` with `delete: [names]`, and, because it costs nothing extra and makes ports meaningful, `set: {name: json_value}` — a language-agnostic way to bind a name to a JSON-ish value, which is what widget-bound variables (Pluto `@bind`, `mo.ui`), papermill-style parameters, and DAG input ports all reduce to. Don't add `get`: `user_expressions` on `execute_request` already evaluates expressions after the cell and returns MIME bundles, and a bare identifier is a valid expression in essentially every language.

**3. Scopes: forkable namespaces**

This is the primitive that unifies your branching problem with reactivity. `create_scope(parent) → scope_id`, `execute_request.scope`, `drop_scope`. A child scope starts as a shallow copy of (or a lookup chain onto) its parent. Run the shared prefix in S0, fork S1 and S2 from it, run branch A in S1 and branch B in S2. Branches are isolated as long as cells *rebind* rather than *mutate* — which is precisely the contract reactive notebooks already impose (marimo doesn't track mutations or attribute assignment). Pluto's implementation of variable deletion is literally this: Julia can't delete a binding from a module, so Pluto evaluates in fresh `workspace` modules and copies surviving bindings across. Scopes also compose with kernel subshells (JEP 91): independent branches can execute concurrently in separate subshells, each in its own scope.

This also clarifies where the earlier snapshot/restore JEP sits. Scopes give you reactive-grade isolation (cheap, shallow, leaks mutation); snapshots give you REPL-grade isolation (expensive, deep, handles side-effecting code). Minimal is scopes; snapshots are the optional tier above for users who won't sign the reactive contract.

**What's already there — use it, don't duplicate it**

`stop_on_error` on `execute_request` aborts queued executions on failure, which is the partial-failure semantics a topological run needs. `silent`/`store_history` keep system-triggered reruns out of history. JupyterLab already sends `cellId` in execute_request metadata, so executions attribute to cells. Comms handle widget value sync. DAP `variables`/`inspectVariables` give introspection for debugger-capable kernels. `supported_features` (JEP 92) advertises each of the three new features independently, so a kernel can offer analysis without scopes or scopes without analysis.

**Language-agnosticism, honestly**

Analysis: good for Python, JS, Julia, R (with caveats), SQL; poor for bash and C++. Delete: Python, R, JS, SQL trivially; Julia only via the module trick; cling only via transaction unloading. Fork: Python dict copy, R `new.env(parent=)`, Julia modules, JS `vm` contexts; not C++, not SQL (copying schemas is not cheap). So all three are optional features with a defined degradation: no analysis → manual edges; no scopes → snapshot/restore or replay; no delete → warn that stale bindings persist. That's the same shape as the debugger: universal contract, per-kernel implementation, advertised capability.

**The one thing to decide before writing any of it**

Whether an edge means "B runs after A in the same namespace" or "B receives A's value". The former is what all of the above supports and keeps kernels as REPLs. The latter — cells as functions with explicit inputs bound from kernel-side value handles, marimo's model taken to its conclusion — makes typed ports and branch isolation trivial but abandons the shared namespace entirely, and that's a much bigger JEP. Start with the first; `set`/`user_expressions` let you emulate value-carrying edges on top of it without committing to the second.

---

## Turn 5

**User:**

Follow up on "1. Code analysis: `analyze_request`": how much does this overlap with the existing language server support/implementation in jupyter/lab? How is the language server stuff currently implemented?

**Claude:**

**How LSP is wired into Jupyter today**

It's two pieces, neither of which touches the kernel. On the server side, `jupyter-lsp` is a jupyter_server extension that spawns language servers as subprocesses (pylsp, pyright, R's languageserver, LanguageServer.jl, texlab, and so on) and proxies their JSON-RPC over a WebSocket. On the frontend side, since JupyterLab 4.0 the plumbing lives in core as `@jupyterlab/lsp` — connection management, document adapters, and the feature registration mechanism — while the user-facing features (diagnostics, hover, jump-to-definition, rename, the LSP completion provider) still come from the separate `jupyterlab-lsp` extension. Core ships the components but no user-facing integration; the LSP service is off by default, and enabling it does nothing until a feature extension is installed, and no language servers come bundled.

The interesting part is how a notebook is presented to a server that only understands files. jupyterlab-lsp builds a *virtual document* by concatenating every cell into one file, maps positions from cells into the concatenated file for requests and back again for responses, so the server only ever sees a single linear Python file. Magics are handled by regex "overrides" that rewrite `%timeit x` into something parseable, and foreign-language cells (`%%sql`, `%%R`) are "transcluded" into separate virtual documents for other servers. Because some servers insist on real files, the server extension mirrors those documents into a `.virtual_documents` directory; that's optional now, via a `requires_documents_on_disk` flag in the server spec.

LSP 3.17 (2022) added native notebook synchronization — `notebookDocument/didOpen` sends each cell as a separate document with its own URI, and `didChange` carries cell additions and deletions — and servers like ruff-lsp have implemented it. jupyterlab-lsp hasn't adopted it: the maintainer's position is that it would simplify the client at the cost of not working with the majority of language servers, and that the cost/benefit ratio isn't clear yet. So today the concatenation model is what you'd be building on.

**How much does that overlap with `analyze_request`?**

Infrastructure: a lot. Semantics: almost none. What reactive/DAG semantics need is per-cell *definitions* and *free variables*, order-independent — exactly what Observable's Notebook Kit computes when it finds each cell's unbound references. LSP has no such request. You can approximate it: `documentSymbol` for top-level definitions, `semanticTokens` to classify identifiers (where the server implements it; support is uneven), `references`/`definition` per name to decide whether a reference is bound inside the cell or outside it. That's many round trips per cell, and the answer still comes out wrong in the ways that matter, because the language server's model is one linear program: a reference resolves to whichever definition precedes it textually, which is meaningless when the same name is defined on two branches of a DAG, or when your view arranges cells out of document order. Even 3.17 keeps the notebook as an ordered sequence forming one program; it makes cells first-class for synchronization, not for scoping.

There are three further mismatches. The language server analyzes the *language*, not the kernel's *dialect* — IPython's transformations (magics, `!`, `?`, `df << %%sql`), Julia macros in the kernel's environment, R's non-standard evaluation — which is why jupyterlab-lsp needs its regex overrides in the first place. It runs in whatever environment jupyter_server lives in, not the kernel's, so its view of imports can differ from what will execute. And it doesn't exist at all where the kernel does: remote kernels behind a gateway, or JupyterLite/WASM. The kernel, by contrast, has the exact parser and pipeline the code will go through. In ipykernel the whole feature is roughly a hundred lines: `shell.transform_cell()` to expand magics, then `ast` or `symtable` to collect module-level assignments, imports, `global` declarations inside functions, and referenced-but-unassigned names; cell magics could additionally declare their own inputs and outputs (rpy2's `%%R -i x -o y` already says exactly that).

The one thing LSP does better is being available while the kernel is busy; `complete_request` queuing behind a long execution is a known pain and part of jupyterlab-lsp's original motivation. Static analysis doesn't need the namespace, so `analyze_request` can go on the control channel, like `debug_request`, which ipykernel services in a separate thread. That neutralizes the advantage. The dynamic complement (`namespace_delta` on `execute_reply`) is inherently kernel-side anyway.

**What I'd actually reuse**

Follow the completer's pattern: JupyterLab 4's completer merges kernel, context, and LSP providers behind one provider manager, and your DAG extension can define an analogous `IAnalysisProvider` with three backends. The kernel provider (`analyze_request`) is primary and exact. An LSP provider, built on jupyterlab-lsp's existing connection manager and virtual-document position maps, is the approximate fallback for kernels that don't implement the feature. A zero-infrastructure heuristic provider can read the Lezer syntax trees CodeMirror 6 already builds for highlighting — assignment and name nodes are enough to *suggest* edges, which is all your manual-wiring fallback needs. That gives you something working on day one for every kernel, with the protocol addition as the upgrade path rather than a prerequisite.

---

*End of the design portion. Later turns (talk proposal, CFP fields, the four-gene model) are summarized in `transcript.md`; the model itself is in `genome-model.md`.*
