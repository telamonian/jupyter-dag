/**
 * Running cells in wire order through JupyterLab's own cell executor.
 *
 * The executor never talks to the kernel directly: each cell goes through `INotebookCellExecutor`
 * (`@jupyterlab/notebook/src/tokens.ts:192`), the same object the notebook toolbar's Run button
 * uses, so kernel selection, markdown rendering, execution counts and error dialogs behave as
 * they do in the notebook. What this module adds is the order (from {@link topologicalOrder}), the
 * optional purge (unbinding what a cell's last run bound) before each code cell and when a cell is
 * deleted, the bookkeeping of node states, and auto-wiring from the kernel's analysis.
 *
 * @module
 */
import { KernelError, NotebookActions, StaticNotebook } from '@jupyterlab/notebook';
import type { INotebookCellExecutor, Notebook } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import type { Cell } from '@jupyterlab/cells';
import type { ISessionContext } from '@jupyterlab/apputils';
import type { Kernel, Session } from '@jupyterlab/services';
import type { ITranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import { downstreamOf, inferWires, replaceWires, topologicalOrder, upstreamOf } from './wiring';
import type { DagGraphModel, ICellNames } from './wiring';
import { FEATURE_ANALYZE, FEATURE_NAMESPACE_DELETE } from './protocol';
import type { DagKernelClient, IAnalyzeCellInput, IAnalyzedCell } from './protocol';

/** A cell's analysis together with the source it was computed from, so a changed source is re-analysed. */
interface IAnalyzedSource {
  /** The source text that was analysed. */
  source: string;
  /** What the kernel said about it. */
  result: IAnalyzedCell;
}

/**
 * The names a cell's last run bound that no other cell's last run also bound.
 *
 * @param executed - Per cell id, the `defined` names of its last successful run.
 * @param cellId - The cell being forgotten.
 * @returns The names to unbind, in the order the cell's run bound them.
 *
 * @remarks
 * A name two cells both bound belongs to whichever ran last, and the record cannot tell which;
 * leaving it is the safe reading, since the other cell's next run rebinds it anyway.
 */
export function namesToUnbind(executed: ReadonlyMap<string, readonly string[]>, cellId: string): string[] {
  const own = executed.get(cellId) ?? [];
  const others = new Set<string>();
  for (const [id, names] of executed) {
    if (id !== cellId) {
      names.forEach(name => others.add(name));
    }
  }
  return own.filter(name => !others.has(name));
}

/** Which cells a run covers. */
export interface IDagRunOptions {
  /** `'all'` runs every cell; `'downstream'` and `'upstream'` take the closure of `roots` including the roots. */
  mode: 'all' | 'downstream' | 'upstream';
  /** The cells to start from, for `'downstream'` and `'upstream'`. */
  roots?: string[];
}

/**
 * Runs cells in wire order through the core cell executor, so each run has the toolbar's semantics.
 *
 * @remarks
 * What `runCell` does. `runCell` (`@jupyterlab/notebook/src/cellexecutor.ts:25`) drives a live
 * `Cell` widget, not a model: it renders a markdown cell and reports it executed
 * (`cellexecutor.ts:37-41`), starts a kernel when the session has none (see
 * `IOptions.sessionDialogs`), runs a code cell with `CodeCell.execute`
 * (`@jupyterlab/cells/src/widget.ts:1744`), and on a kernel error calls `onCellExecuted` with
 * `success: false` and then rethrows the `KernelError`
 * (`@jupyterlab/notebook/src/cellexecutor.ts:116-125`).
 *
 * Why the notebook panel's signals are also watched. `NotebookActions` emits `executed`,
 * `executionScheduled`, `selectionExecuted` and `outputCleared`
 * (`@jupyterlab/notebook/src/actions.tsx:2777-2810`) when cells are run or cleared from the
 * notebook panel, but not when this executor calls `runCell` itself (`Private.runCells`,
 * `actions.tsx:2889`, is what emits them, at `:3035-3038`). So a run from the notebook marks the
 * cell's dependents stale through `_onExecuted`, and a run from here does the same from its own
 * `onCellExecuted` callback; both paths end in {@link DagGraphModel.markStale}.
 *
 * Why cells run one at a time. `Private.runCells` sends every `execute_request` at once
 * (`actions.tsx:2900-2901`) and lets the kernel's `stop_on_error` abort the rest. Here each cell is
 * awaited before the next is sent, because the purge for a cell has to be sent before that cell's
 * `execute_request` (`IDagTransport.namespaceDelete` in `protocol.ts` has the ordering rule), and
 * because stopping at the first failure needs the result before deciding.
 *
 * What the purge unbinds. The purge before a re-run and the one on deletion
 * ({@link DagExecutor.forgetCell}) both unbind what the cell's last run bound, not what its
 * current source defines: if `a = 1` ran and the cell now reads `b = 2`, `a` has to go before `b`
 * is bound. So two records are kept per cell: the analysis of the source as written, with the
 * source it was computed from, and the `defined` list of the source that last ran successfully on
 * this kernel. Cells whose source changed since their analysis are re-analysed in one
 * `analyze_request` before a run and after a run from the notebook panel. Limitation: a cell run
 * from the notebook panel before this executor existed has no record, so its first DAG re-run
 * purges nothing.
 *
 * Why the session's signals are watched. A restart, a kernel change or a shutdown empties the
 * namespace, so the run records are dropped and every code cell's node is marked stale on
 * `statusChanged` with `'restarting'`, `'autorestarting'` or `'dead'`
 * (`@jupyterlab/apputils/src/sessioncontext.tsx:111`) and on any `kernelChanged` that has an old
 * kernel (`sessioncontext.tsx:91`): a swap, a shutdown, a culled session. The first start, with no
 * old kernel, is skipped, so reopening a view on a running kernel changes nothing. Markdown and raw
 * cells read no namespace and are left alone. An interrupt needs nothing: the interrupted cell's
 * reply is an error, `onCellExecuted` records it and the run stops.
 */
export class DagExecutor implements IDisposable {
  /**
   * @param options - The graph, session, executor and client to run with; see {@link DagExecutor.IOptions}.
   */
  constructor(options: DagExecutor.IOptions) {
    this._graph = options.graph;
    this._sessionContext = options.sessionContext;
    this._cellExecutor = options.cellExecutor;
    this._client = options.client;
    this._widgetFor = options.widgetFor;
    this._sessionDialogs = options.sessionDialogs;
    this._translator = options.translator;
    NotebookActions.executed.connect(this._onExecuted, this);
    NotebookActions.executionScheduled.connect(this._onScheduled, this);
    NotebookActions.selectionExecuted.connect(this._onSelectionExecuted, this);
    NotebookActions.outputCleared.connect(this._onOutputCleared, this);
    this._sessionContext.statusChanged.connect(this._onStatusChanged, this);
    this._sessionContext.kernelChanged.connect(this._onKernelChanged, this);
  }

  /**
   * Run the selected cells in wire order; stops at the first failure.
   *
   * @param options - Which cells to run.
   * @returns True when every cell ran successfully.
   *
   * @remarks
   * The session's `ready` promise is awaited so a run started before the kernel connected waits
   * for it instead of failing. On a kernel that can purge, the cells in the set whose source
   * changed since their analysis are analysed in one request before the loop, so each cell's run
   * is recorded with the names it really binds. `remaining` holds the cells still to run so that
   * marking dependents stale after each cell skips the ones this same run is about to execute.
   */
  async run({ mode, roots = [] }: IDagRunOptions): Promise<boolean> {
    const { cellIds, wires } = this._graph;
    let ids = cellIds;
    if (mode !== 'all') {
      const closure = (mode === 'downstream' ? downstreamOf : upstreamOf)(roots, wires, true);
      ids = cellIds.filter(id => closure.has(id));
    }
    await this._sessionContext.ready;
    if (this._client.features.has(FEATURE_NAMESPACE_DELETE)) {
      await this._analyzeChanged(ids).catch(reason =>
        console.warn('jupyter-dag: analysis before the run failed', reason)
      );
    }
    const remaining = new Set(ids);
    for (const cellId of topologicalOrder(ids, wires)) {
      remaining.delete(cellId);
      if (!(await this._runOne(cellId, remaining))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Analyze every code cell afresh and remember the results.
   *
   * @returns The results keyed by cell id; empty when the kernel offers no analysis.
   *
   * @remarks
   * Sends every code cell's source in one `analyze_request`, dropping what was analysed before:
   * the panel calls this when the kernel's features change, so the earlier results may come from
   * another kernel. Markdown and raw cells bind nothing and are not sent.
   */
  async analyzeAll(): Promise<Map<string, IAnalyzedCell>> {
    this._analysis.clear();
    await this._analyzeChanged(this._graph.cellIds);
    return new Map(Array.from(this._analysis, ([id, { result }]) => [id, result]));
  }

  /**
   * Unbind what a cell's last run bound and mark its dependents stale; call it before deleting the cell.
   *
   * @param cellId - The cell about to be deleted.
   * @returns Resolves once the `namespace_delete` request has been sent.
   *
   * @remarks
   * The notebook keeps a deleted cell's bindings; Pluto and marimo unbind them, which is what
   * `namespace_delete` exists for. The dependents are stale because their input really is gone.
   * Names another cell's last run also bound stay ({@link namesToUnbind}). Everything that reads
   * the graph or the records happens before the first `await`, so the caller may delete the cell
   * right after this call, before the wires go with it. Undo brings the cell back but not the
   * binding, as in Pluto, where an undone deletion re-runs the cell.
   */
  async forgetCell(cellId: string): Promise<void> {
    const names = namesToUnbind(this._executed, cellId);
    this._executed.delete(cellId);
    this._analysis.delete(cellId);
    this._markDownstreamStale(cellId);
    if (names.length && this._client.features.has(FEATURE_NAMESPACE_DELETE)) {
      await this._client.namespaceDelete(names);
    }
  }

  /**
   * Replace every wire with the dependencies one round of the kernel's analysis finds.
   *
   * @returns The number of wires set; nothing is touched when the kernel offers no analysis.
   *
   * @remarks
   * The reactive reading of the notebook, done once on demand: code cells whose source changed
   * since their analysis are analysed in one request, then {@link inferWires} joins each cell's
   * referenced names to the nearest cell above it defining them, wrapping round to the bottom of
   * the notebook when nothing above does, and {@link replaceWires} writes the result as one undo
   * step. Cells that did not parse take part with no names, so they lose their wires. Cells whose
   * inputs changed are marked stale, as they are when a wire is removed by hand: what counts as
   * upstream of them just changed.
   */
  async autoWire(): Promise<number> {
    if (!this._client.features.has(FEATURE_ANALYZE)) {
      return 0;
    }
    const ids = this._graph.cellIds;
    await this._analyzeChanged(ids);
    const cells: ICellNames[] = [];
    for (const id of ids) {
      const analysed = this._analysis.get(id)?.result;
      if (analysed && analysed.status !== 'error') {
        cells.push({ id, defined: analysed.defined, referenced: analysed.referenced });
      }
    }
    const wires = inferWires(cells);
    this._graph.markStale(replaceWires(this._graph, wires));
    return wires.length;
  }

  /**
   * Run one cell: purge on kernels that support it, then `runCell`, then record the outcome.
   *
   * @param cellId - The cell to run.
   * @param remaining - The cells this run will still execute afterwards; they are not marked stale.
   * @returns True when the cell ran successfully.
   *
   * @remarks
   * A cell deleted after the run started is skipped rather than failed; its dependents still run
   * in order. The purge is sent only for a code cell and only when the kernel advertises
   * {@link FEATURE_NAMESPACE_DELETE}. `notebook` in the options is the notebook *model*, despite
   * the name (`@jupyterlab/notebook/src/tokens.ts:157`), and `notebookConfig` takes the defaults
   * (`StaticNotebook.defaultNotebookConfig`, `@jupyterlab/notebook/src/widget.ts:1462`). A
   * `KernelError` from `runCell` is caught and reported as `false`: the failure was already
   * recorded through the `onCellExecuted` callback before the rethrow.
   */
  private async _runOne(cellId: string, remaining: ReadonlySet<string>): Promise<boolean> {
    if (!this._graph.findCell(cellId)) {
      return true; // deleted since the run started: skip it and keep going
    }
    const cell = this._widgetFor(cellId);
    if (!cell) {
      this._graph.setState(cellId, 'error');
      return false;
    }
    if (cell instanceof CodeCell && this._client.features.has(FEATURE_NAMESPACE_DELETE)) {
      this._purge(cellId);
    }
    const opts: INotebookCellExecutor.IRunCellOptions = {
      cell,
      notebook: this._graph.notebook,
      notebookConfig: StaticNotebook.defaultNotebookConfig,
      onCellExecuted: ({ success }) => {
        this._graph.setState(cellId, success ? 'fresh' : 'error');
        if (success) {
          this._recordRun(cellId);
          this._markDownstreamStale(cellId, remaining);
        }
      },
      onCellExecutionScheduled: () => this._graph.setState(cellId, 'queued'),
      sessionContext: this._sessionContext,
      sessionDialogs: this._sessionDialogs,
      translator: this._translator
    };
    try {
      return await this._cellExecutor.runCell(opts);
    } catch (e) {
      if (e instanceof KernelError) {
        return false;
      }
      throw e;
    }
  }

  /**
   * Unbind what the cell's last run bound, so a re-run starts from a namespace without its leftovers.
   *
   * @param cellId - The cell about to run.
   *
   * @remarks
   * The names come from the record of the last successful run, not from the current source, so a
   * cell whose source changed still loses its old bindings. The request is not awaited:
   * `IDagTransport.namespaceDelete` in `protocol.ts` states the shell ordering that makes that
   * safe, and the comm case where it is not.
   */
  private _purge(cellId: string): void {
    const names = this._executed.get(cellId) ?? [];
    if (names.length) {
      void this._client.namespaceDelete(names);
    }
  }

  /**
   * Analyze the given cells whose source changed since they were last analysed, in one request.
   *
   * @param ids - Cell ids; markdown and raw cells, and cells whose stored source still matches, are skipped.
   */
  private async _analyzeChanged(ids: Iterable<string>): Promise<void> {
    const cells: IAnalyzeCellInput[] = [];
    for (const id of ids) {
      const cell = this._graph.findCell(id);
      if (!cell || cell.type !== 'code') {
        continue;
      }
      const source = cell.sharedModel.getSource();
      if (this._analysis.get(id)?.source !== source) {
        cells.push({ cell_id: id, code: source });
      }
    }
    if (!cells.length) {
      return;
    }
    for (const result of await this._client.analyze(cells)) {
      const input = cells.find(c => c.cell_id === result.cell_id);
      if (input) {
        this._analysis.set(result.cell_id, { source: input.code, result });
      }
    }
  }

  /** Record what a cell's successful run bound, from its current analysis; nothing when there is none. */
  private _recordRun(cellId: string): void {
    const analysed = this._analysis.get(cellId)?.result;
    if (analysed && analysed.status !== 'error') {
      this._executed.set(cellId, analysed.defined);
    } else {
      this._executed.delete(cellId);
    }
  }

  /** After a run from the notebook panel: analyse the cell if its source changed, then record the run. */
  private async _recordPanelRun(cellId: string): Promise<void> {
    if (!this._client.features.has(FEATURE_NAMESPACE_DELETE)) {
      return;
    }
    await this._analyzeChanged([cellId]);
    this._recordRun(cellId);
  }

  /**
   * Mark the cells downstream of `cellId` stale, except those about to run anyway.
   *
   * @param cellId - The cell that just ran.
   * @param except - Cells not to mark, because this run will execute them next.
   */
  private _markDownstreamStale(cellId: string, except: ReadonlySet<string> = new Set()): void {
    const downstream = downstreamOf([cellId], this._graph.wires, false);
    this._graph.markStale([...downstream].filter(id => !except.has(id)));
  }

  private _onExecuted(
    _: unknown,
    args: { notebook: Notebook; cell: Cell; success: boolean; error?: KernelError | null }
  ): void {
    if (args.notebook.model === this._graph.notebook && args.success) {
      const cellId = args.cell.model.id;
      this._markDownstreamStale(cellId);
      this._recordPanelRun(cellId).catch(reason =>
        console.warn('jupyter-dag: analysis after a notebook run failed', reason)
      );
    }
  }
  private _onScheduled(_: unknown, args: { notebook: Notebook; cell: Cell }): void {
    if (args.notebook.model === this._graph.notebook) {
      this._graph.setState(args.cell.model.id, 'queued');
    }
  }
  private _onSelectionExecuted(_: unknown, args: { notebook: Notebook; lastCell: Cell }): void {
    // TODO: recompute staleness once per batch (run-all / run-selected) instead of per cell in _onExecuted.
    void args;
  }
  private _onOutputCleared(_: unknown, args: { notebook: Notebook; cell: Cell }): void {
    if (args.notebook.model === this._graph.notebook) {
      this._graph.markStale([args.cell.model.id]);
    }
  }
  private _onStatusChanged(_: unknown, status: Kernel.Status): void {
    if (status === 'restarting' || status === 'autorestarting' || status === 'dead') {
      this._onNamespaceLost();
    }
  }
  private _onKernelChanged(_: unknown, { oldValue }: Session.ISessionConnection.IKernelChangedArgs): void {
    if (oldValue) {
      this._onNamespaceLost();
    }
  }
  /** The namespace is gone: forget what ran and mark every code cell stale. */
  private _onNamespaceLost(): void {
    this._executed.clear();
    const ids: string[] = [];
    for (const cell of this._graph.notebook.cells) {
      if (cell.type === 'code') {
        ids.push(cell.id);
      }
    }
    this._graph.markStale(ids);
  }

  /** Whether {@link DagExecutor.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /** Disconnect from the `NotebookActions` and session signals. */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
  }
  private _graph: DagGraphModel;
  private _sessionContext: ISessionContext;
  private _cellExecutor: INotebookCellExecutor;
  private _client: DagKernelClient;
  private _widgetFor: (cellId: string) => Cell | undefined;
  private _sessionDialogs?: ISessionContext.IDialogs;
  private _translator?: ITranslator;
  private _analysis = new Map<string, IAnalyzedSource>();
  private _executed = new Map<string, string[]>();
  private _isDisposed = false;
}
/** Namespace for {@link DagExecutor} statics. */
export namespace DagExecutor {
  /** Options for creating an executor. */
  export interface IOptions {
    /** The graph model: cells, wires and node state. */
    graph: DagGraphModel;
    /** The document's session context, for the kernel to run in. */
    sessionContext: ISessionContext;
    /** JupyterLab's cell executor (the `INotebookCellExecutor` token). */
    cellExecutor: INotebookCellExecutor;
    /** The kernel client, for analysis and purges. */
    client: DagKernelClient;
    /**
     * The live cell widget to run a cell in, or `undefined` if there is none.
     *
     * @param cellId - The cell id.
     */
    widgetFor: (cellId: string) => Cell | undefined;
    /**
     * Dialogs for kernel selection. When the session has no kernel, `runCell` calls
     * `sessionContext.startKernel()` and opens the picker only when these are given
     * (`@jupyterlab/notebook/src/cellexecutor.ts:66-70`); without them a session still without a
     * kernel leaves the cell unexecuted and returns `true` (`:73-78`), and the DAG run carries on
     * to the next cell. Optional for `runCell` too (`@jupyterlab/notebook/src/tokens.ts:181`).
     */
    sessionDialogs?: ISessionContext.IDialogs;
    /**
     * The application translator, for `runCell`'s dialogs; optional there too
     * (`@jupyterlab/notebook/src/tokens.ts:185`).
     */
    translator?: ITranslator;
  }
}
