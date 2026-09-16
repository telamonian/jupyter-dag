import { KernelError, NotebookActions, StaticNotebook } from '@jupyterlab/notebook';
import type { INotebookCellExecutor, INotebookModel, Notebook } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import type { Cell } from '@jupyterlab/cells';
import { SessionContextDialogs } from '@jupyterlab/apputils';
import type { ISessionContext } from '@jupyterlab/apputils';
import { nullTranslator } from '@jupyterlab/translation';
import type { ITranslator } from '@jupyterlab/translation';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import type { ISignal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import { downstreamOf, topologicalOrder, upstreamOf } from './wiring';
import type { DagGraphModel } from './wiring';
import { FEATURE_NAMESPACE_DELETE } from './protocol';
import type { DagKernelClient, IAnalyzedCell } from './protocol';
import type { DagNodeState } from './tokens';

export interface IDagRunOptions {
  mode: 'all' | 'downstream' | 'upstream';
  roots?: string[];
  inclusive?: boolean;
  stopOnError?: boolean;
}
export interface IDagRunEvent {
  cellId: string;
  state: DagNodeState;
  error?: KernelError;
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
  get stateChanged(): ISignal<this, IDagRunEvent> {
    return this._stateChanged;
  }
  get running(): Promise<void> | null {
    return this._running?.promise ?? null;
  }

  async run(options: IDagRunOptions): Promise<boolean> {
    const { cellIds, wires } = this._graph;
    let ids = cellIds;
    if (options.mode === 'downstream') {
      const s = downstreamOf(options.roots ?? [], wires, options.inclusive ?? true);
      ids = cellIds.filter(id => s.has(id));
    }
    if (options.mode === 'upstream') {
      const s = upstreamOf(options.roots ?? [], wires, options.inclusive ?? true);
      ids = cellIds.filter(id => s.has(id));
    }
    return this.runCells(topologicalOrder(ids, wires), options.stopOnError ?? true);
  }

  async runCells(order: string[], stopOnError = true): Promise<boolean> {
    this._running = new PromiseDelegate<void>();
    try {
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
    } finally {
      this._running.resolve();
      this._running = null;
    }
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
      this._emit(cellId, 'error'); // no live widget for this cell (see DagPanel.cellWidget)
      return false;
    }
    if (cell instanceof CodeCell && this._client.features.has(FEATURE_NAMESPACE_DELETE)) {
      this._purge(cellId); // shell is FIFO: the purge is processed before the execute that follows
    }
    const notebook: INotebookModel = this._graph.notebook;
    const opts: INotebookCellExecutor.IRunCellOptions = {
      cell,
      notebook, // the MODEL, despite the name
      notebookConfig: StaticNotebook.defaultNotebookConfig,
      onCellExecuted: ({ success, error }) => {
        this._emit(cellId, success ? 'fresh' : 'error', error ?? undefined);
        if (success) {
          // NotebookActions.executed only fires for notebook-panel runs; mark dependents stale here too.
          const downstream = downstreamOf([cellId], this._graph.wires, false);
          this._graph.markStale([...downstream].filter(id => !remaining.has(id)));
        }
      },
      onCellExecutionScheduled: () => this._emit(cellId, 'queued'),
      sessionContext: this._sessionContext,
      sessionDialogs: this._sessionDialogs,
      translator: this._translator
    };
    try {
      return await this._cellExecutor.runCell(opts); // markdown and raw cells are handled by runCell itself
    } catch (e) {
      if (e instanceof KernelError) {
        this._emit(cellId, 'error', e);
        return false;
      }
      throw e;
    }
  }

  /** 'purge without running': a silent execute of empty code carrying namespace_delete. */
  private _purge(cellId: string): void {
    const analyzed = this._lastAnalysis.get(cellId);
    const names = analyzed && analyzed.status !== 'error' ? analyzed.defined : [];
    if (names.length) {
      void this._client.namespaceDelete(names);
    }
  }

  private _onExecuted(
    _: unknown,
    args: { notebook: Notebook; cell: Cell; success: boolean; error?: KernelError | null }
  ): void {
    if (args.notebook.model !== this._graph.notebook || !args.success) {
      return;
    }
    this._graph.markStale(downstreamOf([args.cell.model.id], this._graph.wires, false));
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
  private _emit(cellId: string, state: DagNodeState, error?: KernelError): void {
    this._graph.setState(cellId, state);
    this._stateChanged.emit({ cellId, state, error });
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
  private _stateChanged = new Signal<this, IDagRunEvent>(this);
  private _running: PromiseDelegate<void> | null = null;
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
