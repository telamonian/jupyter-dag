# The jupyter-dag kernel protocol

## What is added

Three additions to the Jupyter messaging protocol, all optional and all advertised through JEP 92's
`supported_features` in `kernel_info_reply` (`"cell analysis"`, `"namespace delete"`,
`"namespace set"`, `"namespace delta"`):

1. **`analyze_request` / `analyze_reply`**, a new message type on the shell and control channels.
   The request carries a list of `{cell_id, code}`; the reply carries, per cell, the global names
   the cell `defined`, `referenced` and `deleted`, a `dynamic` flag for cells whose effect on the
   namespace cannot be seen statically (`exec`, star imports, `globals()`), a status of `opaque`
   for `%%` cell magics, and a syntax error where the cell did not parse. The kernel does the
   analysis because it has the parser and the dialect: IPython's own input transformer turns
   magics into Python before `ast` and `symtable` run. Analysis reads no namespace, so it can be
   answered on the control channel while a cell is running.
2. **Two optional fields on `execute_request`**: `namespace_delete` (a list of names to unbind
   before the code runs) and `namespace_set` (a mapping of names to JSON values to bind first).
   There is no `get`; `user_expressions` already returns MIME bundles for expressions.
3. **One optional field on `execute_reply`**: `namespace_delta`, the set difference of the
   user-visible names before and after the cell ran (`added`, `removed`). It is on every reply and
   goes to every connected client, so a frontend sees the effect of cells it did not run itself.

Nothing changes in jupyter_server, which relays kernel messages opaquely, and nothing changes in
the file format: wires and node positions live in cell metadata under one key.

For a kernel that has not implemented any of this, the same payloads travel as `comm_msg` data on
a `jupyter-dag` comm target; `%load_ext jupyter_dag` registers that target on a stock IPython
kernel. The comm sends a `features` message on open, because the kernel's `kernel_info_reply`
went out before the extension loaded. The frontend prefers the real message type when the kernel
advertises it and otherwise probes the comm.

## Why this is enough for a cell DAG

A user-drawn DAG needs four things: an order, a way to run cells in that order, protection against
the hidden state a re-run leaves behind, and a place to keep the graph. The order is computed in
the frontend from the wires (a topological sort with ties broken by document order). Running is
the existing `execute_request`; the kernel processes shell messages in order, so sending cells one
after another is the whole scheduler. The graph is metadata. The only thing the kernel has to
contribute is the third item: before a cell re-runs, the names it bound last time are unbound, so
a cell whose source stopped defining `x` does not leave a stale `x` for its dependents. That needs
to know what the cell defined (`analyze_request`) and a way to unbind (`namespace_delete`). Both
are optional: without them the DAG still runs, with the notebook's usual hidden state.

## Why this is enough for reactive execution

A reactive notebook differs from the DAG in one place: the edges are inferred instead of drawn. An
edge from A to B exists when B `referenced` a name that A `defined`; that is a join over the
`analyze_reply` lists and needs nothing else from the kernel. Everything downstream is the DAG
machinery again: when A runs, its dependents are stale and are re-run in topological order.

The remaining reactive semantics map onto the other additions:

- **No hidden state** (Pluto, marimo): deleting a cell unbinds its `defined` names with
  `namespace_delete`; re-running one unbinds them first, as above.
- **Inputs**: a slider, a parameter cell, or a DAG input port binds a value with `namespace_set`
  and the dependents re-run; reading a value back is `user_expressions`.
- **What actually happened**: static analysis is a prediction. `namespace_delta` reports the names
  a run really added or removed, whoever ran it, so a scheduler can correct its graph after cells
  marked `dynamic`, after cells run from another client, and after a purge. The `dynamic` flag
  tells the scheduler which cells to treat conservatively.

Together these cover the execution model of the reactive descendants while keeping the kernel a
REPL: an edge still means "B runs after A in the same namespace", the reading of the design notes
that every language can implement. A SQL kernel can answer `analyze_request` with tables created
and read; an R kernel can unbind with `rm`.

## What it does not cover, on purpose

- Names are not objects. A cell that mutates a list in place, or aliases one, is invisible to the
  analysis and to a set-difference delta; a rebinding of an existing name is invisible to the
  delta as well. Reactive notebooks already impose "rebind, do not mutate" as a contract.
- Branch isolation. Two DAG branches that both rebind `x` share one namespace. The design notes'
  forkable scopes (a child namespace with a parent) are the next tier and are not implemented.
- Concurrency. Cells run one at a time. The DAG is a partial order, and ipykernel 7 subshells are
  a plausible set of lanes, but the delta and IPython's shell globals are not safe for it yet.
- Snapshot and restore of kernel state, the heavier tier of the design, has only its import point
  (a kernel provisioner stub).
