import { KernelError, NotebookActions, StaticNotebook } from '@jupyterlab/notebook';
import type { INotebookCellExecutor, Notebook } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import type { Cell } from '@jupyterlab/cells';
import { SessionContextDialogs } from '@jupyterlab/apputils';
import type { ISessionContext } from '@jupyterlab/apputils';
import { nullTranslator } from '@jupyterlab/translation';
import type { ITranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import { downstreamOf, topologicalOrder, upstreamOf } from './wiring';
import type { DagGraphModel } from './wiring';
import { FEATURE_NAMESPACE_DELETE } from './protocol';
import type { DagKernelClient, IAnalyzedCell } from './protocol';

export interface IDagRunOptions {
  mode: 'all' | 'downstream' | 'upstream';
  roots?: string[];
  inclusive?: boolean;
  stopOnError?: boolean;
}

/** Runs cells in wire order through the core cell executor, so each run has the toolbar's semantics. */
export class DagExecutor implements IDisposable {
  constructor(options: DagExecutor.IOptions) {
    this._graph = options.graph;
    this._sessionContext = options.sessionContext;
    this._cellExecutor = options.cellExecutor;
    this._client = options.client;
    this._widgetFor = options.widgetFor;
    this._translator = options.translator ?? nullTranslator;
    this._sessionDialogs = options.sessionDialogs ?? new SessionContextDialogs({ translator: this._translator });
    NotebookActions.executed.connect(this._onExecuted, this);
    NotebookActions.executionScheduled.connect(this._onScheduled, this);
    NotebookActions.selectionExecuted.connect(this._onSelectionExecuted, this);
    NotebookActions.outputCleared.connect(this._onOutputCleared, this);
  }

  async run(options: IDagRunOptions): Promise<boolean> {
    const { mode, roots = [], inclusive = true, stopOnError = true } = options;
    const { cellIds, wires } = this._graph;
    let ids = cellIds;
    if (mode !== 'all') {
      const closure = (mode === 'downstream' ? downstreamOf : upstreamOf)(roots, wires, inclusive);
      ids = cellIds.filter(id => closure.has(id));
    }
    return this.runCells(topologicalOrder(ids, wires), stopOnError);
  }

  async runCells(order: string[], stopOnError = true): Promise<boolean> {
    await this._sessionContext.ready;
    const remaining = new Set(order);
    for (const cellId of order) {
      remaining.delete(cellId);
      const ok = await this._runOne(cellId, remaining);
      if (!ok && stopOnError) {
        return false;
      }
    }
    return true;
  }

  async analyzeAll(): Promise<Map<string, IAnalyzedCell>> {
    const result = new Map<string, IAnalyzedCell>();
    if (!this._client.supportsAnalyze) {
      return result;
    }
    const cells = Array.from(this._graph.notebook.cells, cell => ({
      cell_id: cell.id,
      code: cell.sharedModel.getSource()
    }));
    for (const c of await this._client.analyze(cells)) {
      result.set(c.cell_id, c);
    }
    this._lastAnalysis = result;
    return result;
  }

  private async _runOne(cellId: string, remaining: ReadonlySet<string>): Promise<boolean> {
    const cell = this._widgetFor(cellId);
    if (!cell) {
      this._graph.setState(cellId, 'error'); // no live widget for this cell (see DagPanel.cellWidget)
      return false;
    }
    if (cell instanceof CodeCell && this._client.features.has(FEATURE_NAMESPACE_DELETE)) {
      this._purge(cellId); // shell is FIFO: the purge is processed before the execute that follows
    }
    const opts: INotebookCellExecutor.IRunCellOptions = {
      cell,
      notebook: this._graph.notebook, // the MODEL, despite the name
      notebookConfig: StaticNotebook.defaultNotebookConfig,
      onCellExecuted: ({ success }) => {
        this._graph.setState(cellId, success ? 'fresh' : 'error');
        if (success) {
          // NotebookActions.executed only fires for notebook-panel runs; mark dependents stale here too.
          this._markDownstreamStale(cellId, remaining);
        }
      },
      onCellExecutionScheduled: () => this._graph.setState(cellId, 'queued'),
      sessionContext: this._sessionContext,
      sessionDialogs: this._sessionDialogs,
      translator: this._translator
    };
    try {
      return await this._cellExecutor.runCell(opts); // markdown and raw cells are handled by runCell itself
    } catch (e) {
      if (e instanceof KernelError) {
        this._graph.setState(cellId, 'error');
        return false;
      }
      throw e;
    }
  }

  /** Unbind what the cell defined last time, so a re-run starts from a namespace without its leftovers. */
  private _purge(cellId: string): void {
    const analyzed = this._lastAnalysis.get(cellId);
    const names = analyzed && analyzed.status !== 'error' ? analyzed.defined : [];
    if (names.length) {
      void this._client.namespaceDelete(names);
    }
  }

  /** Cells downstream of `cellId` are stale, except those about to run anyway. */
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

  get isDisposed(): boolean {
    return this._isDisposed;
  }
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
  private _translator: ITranslator;
  private _sessionDialogs: ISessionContext.IDialogs;
  private _lastAnalysis = new Map<string, IAnalyzedCell>();
  private _isDisposed = false;
}
export namespace DagExecutor {
  export interface IOptions {
    graph: DagGraphModel;
    sessionContext: ISessionContext;
    cellExecutor: INotebookCellExecutor;
    client: DagKernelClient;
    widgetFor: (cellId: string) => Cell | undefined;
    sessionDialogs?: ISessionContext.IDialogs;
    translator?: ITranslator;
  }
}
