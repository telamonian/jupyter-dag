/**
 * The reactive state of one notebook: its kernel client, analysis, switch and scheduler.
 *
 * One controller serves a notebook context, however many panels show it, and keeps the state the
 * `ReactiveScheduler` in `scheduler.ts` is kept free of: which kernel the notebook has and
 * whether it can analyse cells, which cell widgets exist, what each cell's last run bound (for
 * purges), and whether the user has switched reactivity on. `ReactiveRegistry` hands controllers
 * out to the executor, which only has the notebook model, and to the toolbar factory, which has
 * the panel.
 *
 * @module
 */
import { CodeCell } from '@jupyterlab/cells';
import type { Cell } from '@jupyterlab/cells';
import type { ISessionContext } from '@jupyterlab/apputils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { runCell } from '@jupyterlab/notebook';
import type { INotebookCellExecutor, INotebookModel, NotebookPanel } from '@jupyterlab/notebook';
import type { Kernel, Session } from '@jupyterlab/services';
import type { ITranslator } from '@jupyterlab/translation';
import type { IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import type { ISignal } from '@lumino/signaling';
import { CellAnalysisCache } from '../dag/analysis';
import { namesToUnbind } from '../dag/executor';
import { DagKernelClient, FEATURE_ANALYZE, FEATURE_NAMESPACE_DELETE } from '../dag/protocol';
import type { ICellExecution } from '../dag/protocol';
import type { AnalyzeChannel, IWire } from '../dag/tokens';
import { ReactiveScheduler } from './scheduler';
import type { IReactiveHost } from './scheduler';

/** The request payload the scheduler carries: the options `NotebookActions` built for the cell that was asked to run. */
export type RunTrigger = INotebookCellExecutor.IRunCellOptions;

/**
 * Reactive execution for one notebook context.
 *
 * @remarks
 * Availability and the switch. `available` is whether the current kernel advertises
 * {@link FEATURE_ANALYZE}, read off the client's feature set and refreshed with it on every kernel
 * start, change and restart. `enabled` is the switch: it starts off, cannot be turned on while
 * unavailable, and is turned off when the kernel stops being available. {@link ReactiveController.stateChanged}
 * fires on either change, for the toolbar button.
 *
 * Runs. {@link ReactiveController.runCell} is what the `INotebookCellExecutor` token calls for
 * this notebook. With the switch off, for a markdown or raw cell, or while the kernel waits on
 * `input()` (`ISessionContext.pendingInput`, `@jupyterlab/apputils/src/sessioncontext.tsx:121`,
 * where a second request would queue silently behind the prompt), the request goes straight to
 * the core `runCell` (`@jupyterlab/notebook/src/cellexecutor.ts:25`). Otherwise it is queued on
 * the scheduler, which calls back into this class as its host: the cells it pulls in run through
 * the same `runCell` with the triggering request's options and their own cell widget. Those
 * options' callbacks take the cell from their argument (`NotebookActions`, `actions.tsx:3034-3038`),
 * so `NotebookActions.executed` and `executionScheduled` fire for every cell this class runs,
 * and the DAG view's own records stay right.
 *
 * What counts as run. The client reports every `execute_reply` with its cell id
 * ({@link DagKernelClient.cellExecuted}); an ok reply marks the cell run for the scheduler and
 * records what it bound, from the analysis of its source or, failing that, from the reply's
 * `namespace_delta`. That record is what a purge unbinds before the cell runs again, through
 * {@link namesToUnbind}, as the DAG executor does. A restart, kernel change or death resets both
 * (the same signals `DagExecutor` watches, `dag/executor.ts`).
 */
export class ReactiveController implements IDisposable, IReactiveHost<RunTrigger> {
  /**
   * @param options - The context and services; see {@link ReactiveController.IOptions}.
   */
  constructor(options: ReactiveController.IOptions) {
    this._context = options.context;
    this._translator = options.translator;
    this._sessionDialogs = options.sessionDialogs;
    this.client = new DagKernelClient(options.context.sessionContext, options.analyzeChannel);
    this.analysis = new CellAnalysisCache(this.client);
    this.scheduler = new ReactiveScheduler<RunTrigger>(this);
    this.client.featuresChanged.connect(this._onFeaturesChanged, this);
    this.client.cellExecuted.connect(this._onCellExecuted, this);
    options.context.sessionContext.statusChanged.connect(this._onStatusChanged, this);
    options.context.sessionContext.kernelChanged.connect(this._onKernelChanged, this);
    void this.client.detectFeatures();
  }
  /** The kernel client, for features, analysis and purges. */
  readonly client: DagKernelClient;
  /** The analysis of each code cell's current source. */
  readonly analysis: CellAnalysisCache;
  /** The scheduler, with this controller as its host. */
  readonly scheduler: ReactiveScheduler<RunTrigger>;
  /** The notebook model the context holds. */
  get model(): INotebookModel {
    return this._context.model;
  }
  /** Whether the current kernel can analyse cells, which is what reactivity needs. */
  get available(): boolean {
    return this.client.features.has(FEATURE_ANALYZE);
  }
  /** The switch: whether runs from the notebook panel get the reactive treatment. */
  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(value: boolean) {
    if (value && !this.available) {
      return;
    }
    if (value !== this._enabled) {
      this._enabled = value;
      this._stateChanged.emit();
    }
  }
  /** Emitted when `available` or `enabled` changes. */
  get stateChanged(): ISignal<this, void> {
    return this._stateChanged;
  }
  /**
   * Register a panel showing this notebook, as a place to find cell widgets.
   *
   * @param panel - The panel; it is forgotten when disposed.
   */
  addPanel(panel: NotebookPanel): void {
    this._panels.add(panel);
    panel.disposed.connect(() => this._panels.delete(panel));
  }
  /**
   * Run a cell on the notebook's behalf: the `INotebookCellExecutor` entry point for this notebook.
   *
   * @param options - The options `NotebookActions` built for the cell.
   * @returns What the core `runCell` returns for the cell, after any prerequisites ran.
   */
  runCell(options: RunTrigger): Promise<boolean> {
    const { cell } = options;
    if (!this._enabled || !(cell instanceof CodeCell) || options.sessionContext?.pendingInput) {
      return runCell(options);
    }
    return this.scheduler.enqueue(cell.model.id, options);
  }
  /** The ids of the notebook's code cells, in document order. */
  codeCellIds(): string[] {
    const ids: string[] = [];
    for (const cell of this.model.cells) {
      if (cell.type === 'code') {
        ids.push(cell.id);
      }
    }
    return ids;
  }
  /** Re-analyse the cells whose source changed; a failure is logged and the stale analysis kept. */
  async refresh(): Promise<void> {
    try {
      await this.analysis.refresh(this.model.cells);
    } catch (reason) {
      console.warn('jupyter-dag: analysis before a reactive run failed', reason);
    }
  }
  /** The wires the current analysis implies. */
  wires(): IWire[] {
    return this.analysis.wires(this.codeCellIds());
  }
  /**
   * Run one cell through the core `runCell`, with the triggering request's options.
   *
   * @param cellId - The cell to run.
   * @param trigger - The options of the request this run belongs to.
   * @returns True when the cell ran, or no longer has a widget (deleted since it was queued).
   */
  run(cellId: string, trigger: RunTrigger): Promise<boolean> {
    const cell = this._widgetFor(cellId);
    if (!cell || cell.isDisposed) {
      return Promise.resolve(true);
    }
    return runCell({
      ...trigger,
      cell,
      sessionDialogs: trigger.sessionDialogs ?? this._sessionDialogs,
      translator: trigger.translator ?? this._translator
    });
  }
  /**
   * Unbind what the cell's last run bound, on kernels that can; the request is not awaited.
   *
   * @param cellId - The cell about to run again.
   */
  purge(cellId: string): void {
    const names = namesToUnbind(this._executed, cellId);
    if (names.length && this.client.features.has(FEATURE_NAMESPACE_DELETE)) {
      void this.client.namespaceDelete(names);
    }
  }
  /** Whether {@link ReactiveController.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /** Dispose the client and disconnect from the session. */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
    this.client.dispose();
  }
  private _widgetFor(cellId: string): Cell | undefined {
    for (const panel of this._panels) {
      const cell = panel.content.widgets.find(c => c.model.id === cellId);
      if (cell) {
        return cell;
      }
    }
    return undefined;
  }
  private _onFeaturesChanged(): void {
    if (!this.available) {
      this._enabled = false;
    }
    this.analysis.clear();
    this._stateChanged.emit();
  }
  private _onCellExecuted(_: unknown, { cellId, status, delta }: ICellExecution): void {
    if (status !== 'ok') {
      return;
    }
    this.scheduler.markRan(cellId);
    const analysed = this.analysis.get(cellId);
    const defined = analysed && analysed.status !== 'error' ? analysed.defined : delta?.added;
    if (defined) {
      this._executed.set(cellId, defined);
    } else {
      this._executed.delete(cellId);
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
  /** The namespace is gone: every cell counts as never run, and there is nothing to purge. */
  private _onNamespaceLost(): void {
    this.scheduler.reset();
    this._executed.clear();
  }
  private _context: DocumentRegistry.IContext<INotebookModel>;
  private _translator?: ITranslator;
  private _sessionDialogs?: ISessionContext.IDialogs;
  private _panels = new Set<NotebookPanel>();
  private _executed = new Map<string, string[]>();
  private _enabled = false;
  private _stateChanged = new Signal<this, void>(this);
  private _isDisposed = false;
}
/** Namespace for {@link ReactiveController} statics. */
export namespace ReactiveController {
  /** Options for creating a controller. */
  export interface IOptions {
    /** The notebook's document context: model and session. */
    context: DocumentRegistry.IContext<INotebookModel>;
    /** The channel `analyze_request` goes out on; the `analyzeChannel` setting. */
    analyzeChannel: AnalyzeChannel;
    /** Dialogs for kernel selection, used when the triggering request carries none. */
    sessionDialogs?: ISessionContext.IDialogs;
    /** The application translator, used when the triggering request carries none. */
    translator?: ITranslator;
  }
}

/**
 * Where the executor and the toolbar meet: one {@link ReactiveController} per notebook context.
 *
 * @remarks
 * The executor is handed the notebook *model* (`INotebookCellExecutor.IRunCellOptions.notebook`,
 * `@jupyterlab/notebook/src/tokens.ts:157`), the toolbar factory the panel, so controllers are
 * findable both ways. A controller is created on first use, by whichever comes first: the toolbar
 * factory runs while the panel is being built (`ABCWidgetFactory.createNew`,
 * `@jupyterlab/docregistry/src/default.ts:465-476`), before the tracker learns of the panel. It is
 * disposed with its context.
 */
export class ReactiveRegistry {
  /**
   * @param options - The services every controller gets; `analyzeChannel` may be changed later, for controllers made afterwards.
   */
  constructor(options: ReactiveRegistry.IOptions = {}) {
    this.options = options;
  }
  /** The services for new controllers; the plugin fills `analyzeChannel` in once settings load. */
  options: ReactiveRegistry.IOptions;
  /**
   * The controller of a notebook model, if a panel on it has been registered.
   *
   * @param model - The model the executor was given.
   */
  controllerFor(model: INotebookModel): ReactiveController | undefined {
    return this._byModel.get(model);
  }
  /**
   * The controller for a panel's notebook, created on first call for that context.
   *
   * @param panel - The panel; registered with the controller as a place to find cell widgets.
   */
  ensure(panel: NotebookPanel): ReactiveController {
    const { context } = panel;
    let controller = this._byContext.get(context);
    if (!controller) {
      const created = new ReactiveController({
        context,
        analyzeChannel: this.options.analyzeChannel ?? 'shell',
        sessionDialogs: this.options.sessionDialogs,
        translator: this.options.translator
      });
      controller = created;
      this._byContext.set(context, created);
      this._byModel.set(context.model, created);
      context.disposed.connect(() => {
        this._byContext.delete(context);
        this._byModel.delete(context.model);
        created.dispose();
      });
    }
    controller.addPanel(panel);
    return controller;
  }
  private _byContext = new WeakMap<DocumentRegistry.IContext<INotebookModel>, ReactiveController>();
  private _byModel = new WeakMap<INotebookModel, ReactiveController>();
}
/** Namespace for {@link ReactiveRegistry} statics. */
export namespace ReactiveRegistry {
  /** The services passed to every controller. */
  export interface IOptions {
    /** The `analyzeChannel` setting; `'shell'` until the settings load. */
    analyzeChannel?: AnalyzeChannel;
    /** Dialogs for kernel selection. */
    sessionDialogs?: ISessionContext.IDialogs;
    /** The application translator. */
    translator?: ITranslator;
  }
}
