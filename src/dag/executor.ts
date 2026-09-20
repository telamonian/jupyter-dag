/**
 * Running cells in wire order through JupyterLab's own cell executor.
 *
 * The executor never talks to the kernel directly: each cell goes through `INotebookCellExecutor`
 * (`@jupyterlab/notebook/src/tokens.ts:192`), the same object the notebook toolbar's Run button
 * uses, so kernel selection, markdown rendering, execution counts and error dialogs behave as
 * they do in the notebook. What this module adds is the order (from {@link topologicalOrder}), the
 * optional purge (unbinding what a cell defined last time) before each code cell, and the
 * bookkeeping of node states.
 *
 * @module
 */
import { KernelError, NotebookActions, StaticNotebook } from '@jupyterlab/notebook';
import type { INotebookCellExecutor, Notebook } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import type { Cell } from '@jupyterlab/cells';
import type { ISessionContext } from '@jupyterlab/apputils';
import type { ITranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import { downstreamOf, topologicalOrder, upstreamOf } from './wiring';
import type { DagGraphModel } from './wiring';
import { FEATURE_NAMESPACE_DELETE } from './protocol';
import type { DagKernelClient, IAnalyzedCell } from './protocol';

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
 * (`cellexecutor.ts:37-41`), starts a kernel when the session has none and asks the user to pick
 * one if `sessionDialogs` is given (`cellexecutor.ts:66-70`), runs a code cell with
 * `CodeCell.execute` (`@jupyterlab/cells/src/widget.ts:1744`), and on a kernel error calls
 * `onCellExecuted` with `success: false` and then rethrows the `KernelError`
 * (`@jupyterlab/notebook/src/cellexecutor.ts:116-125`). `sessionDialogs` and `translator` are
 * optional in its options (`@jupyterlab/notebook/src/tokens.ts:181`, `:185`), so they are passed
 * through as given.
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
 * awaited before the next is sent, because the purge for a cell has to precede that cell's
 * execute request on the shell channel and the kernel processes shell messages in order, and
 * because stopping at the first failure needs the result before deciding.
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
  }

  /**
   * Run the selected cells in wire order; stops at the first failure.
   *
   * @param options - Which cells to run.
   * @returns True when every cell ran successfully.
   *
   * @remarks
   * {@link topologicalOrder} ignores wires that leave the chosen cell set. The session's `ready`
   * promise is awaited so a run started before the kernel connected waits for it instead of
   * failing. `remaining` holds the cells still to run so that marking dependents stale after each
   * cell skips the ones this same run is about to execute.
   */
  async run({ mode, roots = [] }: IDagRunOptions): Promise<boolean> {
    const { cellIds, wires } = this._graph;
    let ids = cellIds;
    if (mode !== 'all') {
      const closure = (mode === 'downstream' ? downstreamOf : upstreamOf)(roots, wires, true);
      ids = cellIds.filter(id => closure.has(id));
    }
    await this._sessionContext.ready;
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
   * Ask the kernel to analyze every cell and remember the results for the purge.
   *
   * @returns The results keyed by cell id; empty when the kernel offers no analysis.
   *
   * @remarks
   * Sends the whole notebook's source in one `analyze_request`. The results are remembered as the
   * basis of the next purge, which needs the names a cell defined the last time it was analysed.
   */
  async analyzeAll(): Promise<Map<string, IAnalyzedCell>> {
    const cells = Array.from(this._graph.notebook.cells, cell => ({
      cell_id: cell.id,
      code: cell.sharedModel.getSource()
    }));
    const result = new Map<string, IAnalyzedCell>();
    for (const c of await this._client.analyze(cells)) {
      result.set(c.cell_id, c);
    }
    this._lastAnalysis = result;
    return result;
  }

  /**
   * Run one cell: purge, then `runCell`, then record the outcome.
   *
   * @param cellId - The cell to run.
   * @param remaining - The cells this run will still execute afterwards; they are not marked stale.
   * @returns True when the cell ran successfully.
   *
   * @remarks
   * `widgetFor` is the panel's `cellWidget` (`document.tsx`); with no widget the cell is marked
   * `error` and the run stops. `notebook` in the options is the notebook *model*, despite the name
   * (`@jupyterlab/notebook/src/tokens.ts:157`), and `notebookConfig` takes the defaults
   * (`StaticNotebook.defaultNotebookConfig`, `@jupyterlab/notebook/src/widget.ts:1462`). A
   * `KernelError` from `runCell` is caught and reported as `false`: the failure was already
   * recorded through the `onCellExecuted` callback before the rethrow (see the class remarks).
   */
  private async _runOne(cellId: string, remaining: ReadonlySet<string>): Promise<boolean> {
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
   * Unbind what the cell defined last time, so a re-run starts from a namespace without its leftovers.
   *
   * @param cellId - The cell about to run.
   *
   * @remarks
   * The names are the `defined` list of the last {@link DagExecutor.analyzeAll}; the other lists
   * are not used yet, and a cell that was never analysed or whose analysis failed is not purged.
   * The `namespace_delete` request is not awaited: it goes out on the shell channel before the
   * cell's `execute_request`, and the kernel handles shell messages in order, so the purge has
   * happened by the time the cell runs. Only kernels advertising {@link FEATURE_NAMESPACE_DELETE}
   * get one.
   */
  private _purge(cellId: string): void {
    const analyzed = this._lastAnalysis.get(cellId);
    const names = analyzed && analyzed.status !== 'error' ? analyzed.defined : [];
    if (names.length) {
      void this._client.namespaceDelete(names);
    }
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
      this._markDownstreamStale(args.cell.model.id);
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

  /** Whether {@link DagExecutor.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /** Disconnect from the `NotebookActions` signals. */
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
  private _lastAnalysis = new Map<string, IAnalyzedCell>();
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
     * Dialogs for kernel selection; without them `runCell` calls `sessionContext.startKernel()` and
     * skips the picker (`@jupyterlab/notebook/src/cellexecutor.ts:66-70`), so a session with no
     * kernel leaves the cell unexecuted and returns `true` (`:73-78`) and the DAG run carries on to
     * the next cell.
     */
    sessionDialogs?: ISessionContext.IDialogs;
    /** The application translator, for `runCell`'s dialogs. */
    translator?: ITranslator;
  }
}
