# Design notes: language-agnostic reactive execution and cell DAGs for Jupyter

Working name "Jupyter-DAG". Nothing here exists publicly yet; it is an in-progress
design plus a prototype to be built for the Jupyter Day talk (Oct 19, 2026).

## 1. The core observation

A user-drawn DAG of cells (with branching) and a reactive notebook (marimo/Pluto
style) need the same kernel primitives. They differ only in where edges come from:
inferred by the kernel (reactive) or drawn by the user (DAG). Topological
scheduling, staleness marking, cycle detection, run modes, and persistence of the
graph are frontend/server work and stay out of the kernel.

## 2. Minimal kernel-protocol additions

All optional features advertised via `kernel_info_reply.supported_features`
(JEP 92; subshells JEP 91 and the debugger use the same mechanism).

### 2a. `analyze_request` / `analyze_reply`
Input: one or more code strings. Output per cell: `defines`, `references`,
`imports`, plus `confidence` / `has_unknown_references` (Python exec/star
imports, R non-standard evaluation, Julia macros). Kernel-side because the kernel
has the parser and dialect (IPython magics via `shell.transform_cell()`, then
`ast`/`symtable`: module-level assignments, imports, `global` inside functions,
referenced-but-unassigned names; ~100 lines in ipykernel; cell magics can declare
their own I/O, e.g. rpy2 `%%R -i x -o y`). Static analysis needs no namespace, so
serve it on the control channel (like `debug_request`) to avoid queuing behind a
busy shell. Even a SQL kernel can implement it (tables created/read).
Dynamic complement: optional `namespace_delta: {added, rebound, removed}` on
`execute_reply` (diff global names/identity before and after; ipyflow proves it
works inside ipykernel).
Fallback for kernels without it: the manual DAG wiring. Frontend abstraction:
an `IAnalysisProvider` with three backends — kernel (exact), LSP-derived
(approximate, via jupyterlab-lsp's connection manager and virtual-document
position maps), Lezer syntax tree from CodeMirror 6 (heuristic, zero infra) —
mirroring how JupyterLab's completer merges kernel/context/LSP providers.

### 2b. Namespace ops
`namespace_request` with `delete: [names]` (invalidation before re-run; Pluto and
marimo both do this; Julia can't delete a binding, Pluto uses fresh `workspace`
modules) and `set: {name: json}` (bind a JSON value; widget-bound variables,
papermill-style parameters, DAG input ports). No `get`: `user_expressions` on
`execute_request` already returns MIME bundles for expressions.

### 2c. Scopes
`create_scope(parent) → scope_id`, `execute_request.scope`, `drop_scope`. Child =
shallow copy of / lookup chain onto parent (Python dict copy, R `new.env(parent=)`,
Julia modules, JS vm contexts; not C++/cling, not SQL). Reactive-grade branch
isolation: correct as long as cells rebind rather than mutate — the contract
reactive notebooks already impose. Composes with subshells for concurrent branches.

### 2d. Already in the protocol — reuse
`stop_on_error` (abort queued executions on failure), `silent`/`store_history`,
`cellId` in execute_request metadata, comms for widget sync, DAP
`variables`/`inspectVariables` for introspection, `supported_features`.

### 2e. Decide first
Does an edge mean "B runs after A in the same namespace" (supported by all of the
above; kernels stay REPLs) or "B receives A's value" (cells as functions over
kernel-side value handles — marimo's model taken to its conclusion; a much bigger
JEP)? Start with the first; `set` + `user_expressions` emulate the second.

## 3. State snapshots (the heavier, optional tier)

No language-independent representation of interpreter state exists; "vars +
functions + classes" is a reconstruction script, i.e. replay. The universal part
is the contract:
- `snapshot_request`/`snapshot_reply` on the shell channel (ordered with
  executions), reply carries `snapshot_id`, `fidelity: full|partial`,
  `uncaptured: [{name, reason}]`; `restore_request`, list, delete; language-
  neutral manifest + opaque blob by format id; blobs stay kernel-side.
- Semantics to define: quiescence (all subshells idle), comms invalidated on
  restore (widget state is half in the frontend), execution counter policy,
  external side effects not undone, partial fidelity always reported.
Tiers: (1) replay — every kernel, correct by construction; (2) process-level —
CRIU/DMTCP via a jupyter_client `KernelProvisioner` + server endpoint, needs no
kernel cooperation, Linux only, kernel rebinds ZMQ ports, `--tcp-close`,
`cuda-checkpoint` for GPU; (3) language-native — dill/cloudpickle over `user_ns`
with per-object fallback (Kishu, ElasticNotebook), R `save.image()`, Julia
`Serialization`, JVM CRaC. Kishu's paper: incremental CRIU comparable on
checkpoint, up to 36× slower on checkout. For DAG fan-out, "clone kernel" is a
better primitive than save/restore (restore one image twice; replay emulates it).
Scopes give reactive-grade isolation cheaply; snapshots give REPL-grade isolation.

## 4. Relationship to LSP

jupyter-lsp spawns language servers server-side and proxies JSON-RPC; core has
`@jupyterlab/lsp` plumbing since 4.0, features live in jupyterlab-lsp; notebooks
are concatenated into a virtual document with position maps; magics handled by
regex overrides; LSP 3.17 notebook sync exists but jupyterlab-lsp hasn't adopted
it (most servers don't support it). LSP has no "free variables of this fragment"
request; its model is one linear program (references resolve textually), it runs
in jupyter_server's environment not the kernel's, and doesn't exist for remote or
WASM kernels. Reuse its infrastructure for the fallback provider only.
Precedent: Databricks' DBLS (JupyterCon 2025) embeds a language server in the
kernel and enriches `complete_request` with runtime context.

## 5. Frontend: the DAG view

Use React Flow (`@xyflow/react`, MIT, v12.x): nodes are React DOM components, so
a Lumino `CodeCell` (from `@jupyterlab/cells`) can be mounted in a custom node via
`Widget.attach` in a ref'd div. Open as a second `DocumentWidget` on the same
`INotebookModel`, building cell widgets from the shared cell models (verify two
CodeCell widgets on one model behave — first thing to prototype). Use
`nodrag`/`nowheel`/`nopan` on editors and outputs; `Handle` + `isValidConnection`
for typed ports; `NodeResizer`; parent nodes for grouping; dagre/ELK layout; clamp
zoom near 1 (ipywidgets/plotly under CSS scale). Persist positions/edges in cell
metadata. Runner-up: Rete.js v2. Not viable: the ComfyUI litegraph fork
(archived Aug 2025 into the ComfyUI_frontend monorepo as an internal module;
frontend repo is GPL-3.0; canvas-rendered nodes; ComfyUI itself is moving nodes to
Vue DOM). Prior art to read: marimo's dependency explorer (React Flow + ELK),
Elyra's pipeline editor (a node-graph editor inside JupyterLab), Hex Graph view.

## 6. Process

Prototype without touching the protocol: a comm target in ipykernel for the
messages above, the JupyterLab extension, optionally a CRIU provisioner. Validate
on ipykernel + one xeus kernel, then open a pre-proposal issue in
jupyter/enhancement-proposals. Subshells (JEP 91 → ipykernel 7 → other kernels)
is the model path.
