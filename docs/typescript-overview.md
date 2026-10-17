# The TypeScript side, by function

The frontend is a JupyterLab extension: a second document view on the notebook model that draws
cells as nodes and wires as execution order, and a kernel client for the protocol additions. About
3000 lines in `src/dag/`, all documented with TSDoc and validated by TypeDoc.

## Talking to the kernel

`src/dag/protocol.ts` mirrors `jupyter_dag/protocol.py` (constants, message-body interfaces) and
implements the client. `ShellTransport` sends `analyze_request` as a real message on the shell or
control channel, using a known request type as a stand-in because `@jupyterlab/services` types
the message-type unions as closed; a purge is a silent `execute_request` of empty code carrying
`namespace_delete`. `CommTransport` sends the same payloads over the `jupyter-dag` comm and reads
the reply out of the request future's iopub stream. `DagKernelClient` sits on the document's
session context, detects features from the first `kernel_info_reply` (falling back to a comm
probe), re-detects on kernel change and on both kinds of restart, and emits `featuresChanged` and
`namespaceDelta` (read from every `execute_reply` the connection receives, whoever sent it).

## The public API and the file format

`src/dag/tokens.ts` is what `src/index.ts` re-exports: the plugin, factory, command and metadata
ids, the settings shape, the shapes persisted in the notebook (per cell, `inputs` listing the
source ids of inbound wires plus position and size; per notebook, layout direction and viewport),
`IWire`, the node execution states, and the two Lumino tokens (`IDagTracker` for open views,
`IDagGraphModelFactory` for the reactive plugin to obtain a graph model). It imports none of the
view code, so another extension can depend on it without pulling in React Flow. `readCellMetadata`
sanitises stored metadata, dropping non-finite numbers that would otherwise poison the canvas.

## Wires and the graph model

`src/dag/wiring.ts` reads and writes the metadata (whole-object merges, since ydoc's setter deletes
on `undefined` and skips deep-equal writes), derives wires from `inputs` while ignoring dangling
sources (so an undo brings a wire back), and holds the graph algorithms: downstream and upstream
closures, cycle detection, and a Kahn topological sort with document-order tie-breaking, after
ipyflow's closure code. `DagGraphModel` fans the notebook model's signals (cell list changes,
metadata changes filtered to `inputs`, source edits) into one `changed` signal, caches the wire
list between changes, and keeps the ephemeral per-node state (`fresh`, `stale`, `queued`,
`error`). It writes nothing back to the document.

## Running cells

`src/dag/executor.ts` runs cells through JupyterLab's own `INotebookCellExecutor`, the object the
notebook toolbar uses, so kernel selection, markdown rendering, execution counts and error dialogs
behave as in the notebook. It chooses the cell set (all, downstream of roots, upstream of roots),
orders it, and runs one cell at a time so that each cell's purge precedes its `execute_request` on
the shell channel and a failure stops the run. On kernels that advertise the feature, the purge
unbinds what the cell's last run bound before it re-runs, and `forgetCell` does the same when a
cell is deleted from the DAG view, marking its dependents stale; the executor keeps each cell's
analysis together with the source it came from, re-analyses changed cells in one request before a
run and after a notebook-panel run, and drops its run records on a restart. `autoWire` is the reactive reading done once on demand: it analyses every code cell and replaces all wires with one from each referenced name to the nearest cell above that defines it, wrapping round to the bottom of the notebook when none does; a wrapped wire that would close a cycle is skipped. It also watches `NotebookActions`' signals so a cell run from
the notebook panel marks its dependents stale too, and the session's signals so a kernel restart
or swap marks every node stale.

`src/dag/cells.ts` inserts, deletes and clears cells without a notebook widget, mirroring the
shared-model bodies of the `NotebookActions` functions, which need one.

## The view

`src/dag/document.tsx` is the JupyterLab plumbing: `DagPanel` (a `ReactWidget` that owns the graph
model, kernel client and executor, mounts the canvas once the context is ready, re-analyses on
`featuresChanged`, and keeps cell mime types in step with the kernel), `DagDocument` (the
`DocumentWidget` around it, with its toolbar from the settings schema), and `DagWidgetFactory`,
whose `modelName: 'notebook'` is what makes the document manager share the notebook panel's context
and model rather than opening a second one.

`src/dag/canvas.tsx` is the React Flow canvas in controlled mode: nodes and edges are rebuilt from
the graph model on every change while keeping existing node objects, so positions, measurements
and selection survive; gestures go the other way, with finished drags and resizes persisted to
cell metadata in one undoable transaction and connections and reconnections turned into wire
adds and removes with a cycle check on every pointer move. Auto-layout waits until every node is
measured and the pane has a size. `src/dag/layout.ts` drives dagre and stacks unwired cells in a
side column, after marimo.

`src/dag/cellnode.tsx` is the node: a real Lumino `Cell` widget built through the notebook's
content factory over the shared cell model, attached inside a React-owned `div` in a layout effect
(so detach happens while the host is still in the DOM), resized by hand since it has no Lumino
parent, with an output-only fallback for code cells. Each node reads its own state from the graph
model, so a state change re-renders one node rather than the array. A selected node shows four
icon buttons under it (run downstream, remove cell, remove edges, clear output), and the
stylesheet highlights the outline wherever a drag could start. `src/dag/wireedge.tsx` is the
edge: the built-in bezier path plus a remove button at its upper end while selected.

## Plugins and settings

`src/dag/plugin.ts` has three plugins. The view plugin registers the widget factory, tracks open
views for layout restore, adds the open, add-cell, run, auto-layout, interrupt, restart, undo
and redo commands (`Z` and `Shift Z` undo and redo the notebook's last change while focus is in
the DAG view but not in an editor), registers the toolbar items that are widgets rather than
commands (the new-cell type
dropdown, the kernel-name button and the execution indicator; `src/dag/toolbar.tsx`), and loads
the settings; it creates the toolbar factory first because the schema's `jupyter.lab.transform`
flag makes `settingRegistry.load` fail until a transformer exists. The graph-model plugin
provides `IDagGraphModelFactory` on its own so the reactive plugin can require it without
activating the view. The kernel-status plugin lets the status bar's kernel item show the kernel
of a current DAG tab. `schema/plugin.json` declares the settings (layout direction, max zoom,
output-only nodes, analyze channel), the notebook and DAG toolbars, and the View menu entry, all
bound to the view plugin's id.

## Tooling

TSDoc comments follow one shape (summary, `@remarks`, tags) and cite the installed JupyterLab,
Lumino and ydoc sources by `@scope/pkg/src/file.ts:line`; `docs/typedoc-source-links.js` turns
those into GitHub permalinks at the installed versions' tags when `jlpm docs` renders the site,
and `jlpm docs:check` fails on any undocumented export or broken link. `eslint-plugin-tsdoc` checks
tag syntax. Jest covers the layout and graph algorithms; `jlpm build` produces the labextension
that `pip install -e .` and `jupyter-builder develop` register.
