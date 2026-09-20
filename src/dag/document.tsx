/**
 * The DAG view as a JupyterLab document: the panel widget, the document widget around it, and the
 * widget factory that creates them for a notebook context.
 *
 * A notebook opened as a DAG is a second document widget on the same context, and therefore the
 * same model, as the notebook panel. The document manager keeps one context per path and model
 * factory (`_findContext`, `@jupyterlab/docmanager/src/manager.ts:548-558`), so what makes the two
 * views share a model is the factory's `modelName: 'notebook'`: the manager resolves the model
 * factory from that name (`manager.ts:672-673`) and reuses the notebook's context when it exists
 * (`manager.ts:690`). With any other model name the DAG view would get a context and model of its
 * own.
 *
 * @module
 */
import React from 'react';
import { ABCWidgetFactory, DocumentWidget } from '@jupyterlab/docregistry';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { INotebookCellExecutor, INotebookModel, INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import type { ISessionContext } from '@jupyterlab/apputils';
import { LabIcon, ReactWidget } from '@jupyterlab/ui-components';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { IEditorMimeTypeService } from '@jupyterlab/codeeditor';
import type { Cell } from '@jupyterlab/cells';
import { nullTranslator } from '@jupyterlab/translation';
import type { ITranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import { DagCanvas } from './canvas';
import type { ICellNodeContext } from './cellnode';
import { DagGraphModel } from './wiring';
import { DagExecutor } from './executor';
import { DagKernelClient } from './protocol';
import type { IDagDocument, IDagSettings } from './tokens';

/** The tab icon of a DAG view: three nodes and two wires, in JupyterLab's icon style. */
export const dagIcon = new LabIcon({
  name: 'jupyter-dag:dag',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161"><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="12" cy="19" r="3"/><path d="M6.5 7.5 10.5 16M17.5 7.5 13.5 16" stroke="#616161" stroke-width="2" fill="none"/></g></svg>'
});

/**
 * The React Flow canvas as a Lumino widget; owns the graph model, kernel client and executor.
 *
 * @remarks
 * Why the canvas is mounted only when the context is ready. `ReactWidget`
 * (`@jupyterlab/ui-components/src/components/vdom.ts:22`) renders on every update request and
 * sends itself one when attached (`vdom.ts:54`, `:61`). `MainAreaWidget` adds its content to its
 * layout at construction (`@jupyterlab/apputils/src/mainareawidget.ts:70`) and, when given a
 * `reveal` promise, only overlays a spinner until it resolves (`mainareawidget.ts:82-93`); the
 * content is attached and rendered underneath. `DocumentWidget` makes that promise include
 * `context.ready` (`@jupyterlab/docregistry/src/default.ts:558`), so on a layout restore this
 * panel renders before the notebook file has loaded. Rendering the canvas then would hand React
 * Flow an empty graph, whose bounds are infinite; instead `render` returns an empty element until
 * `context.isReady` (`@jupyterlab/docregistry/src/registry.ts:970`) and the constructor requests a
 * re-render when `context.ready` resolves.
 *
 * Bootstrap order. The panel re-analyses the notebook on every `featuresChanged` of the kernel
 * client. One explicit detection at construction covers a kernel that is already running, which
 * is the case when a DAG view is opened next to a notebook panel that started it. Mime types are
 * set the same way the notebook panel sets them: from `kernel.info`'s `language_info`, on every
 * kernel change (`NotebookPanel._onKernelChanged`, `@jupyterlab/notebook/src/panel.ts:193-206`,
 * and `StaticNotebook._updateMimetype`, `@jupyterlab/notebook/src/widget.ts:871`).
 */
export class DagPanel extends ReactWidget {
  /**
   * @param options - The context and services; see {@link DagPanel.IOptions}.
   */
  constructor(options: DagPanel.IOptions) {
    super();
    this.addClass('jp-DagPanel');
    this.context = options.context;
    this.settings = options.settings;
    this._mimeTypeService = options.mimeTypeService;
    this._notebookTracker = options.notebookTracker;
    this.graph = new DagGraphModel(options.context.model);
    this.client = new DagKernelClient(this.context.sessionContext, this.settings.analyzeChannel);
    this.executor = new DagExecutor({
      graph: this.graph,
      sessionContext: this.context.sessionContext,
      cellExecutor: options.cellExecutor,
      client: this.client,
      widgetFor: id => this.cellWidget(id),
      sessionDialogs: options.sessionDialogs,
      translator: options.translator
    });
    this._nodeContext = {
      contentFactory: options.contentFactory,
      rendermime: options.rendermime,
      translator: options.translator ?? nullTranslator,
      graph: this.graph,
      outputOnly: this.settings.outputOnlyNodes,
      registerWidget: (id, cell) => {
        if (cell) {
          this._widgets.set(id, cell);
        } else {
          this._widgets.delete(id);
        }
      },
      onRunDownstream: id => void this.executor.run({ mode: 'downstream', roots: [id] })
    };
    this.client.featuresChanged.connect(this._analyze, this);
    this.context.sessionContext.kernelChanged.connect(this._updateMimeTypes, this);
    void this.client.detectFeatures();
    void this._updateMimeTypes();
    void this.context.ready.then(() => this.update());
  }
  /** The document context shared with the notebook panel. */
  readonly context: DocumentRegistry.IContext<INotebookModel>;
  /** The settings this view was created with. */
  readonly settings: IDagSettings;
  /** The graph model over the notebook. */
  readonly graph: DagGraphModel;
  /** The kernel client: feature detection, analysis, purges. */
  readonly client: DagKernelClient;
  /** The executor the toolbar and node buttons run cells through. */
  readonly executor: DagExecutor;
  /** Re-run auto-layout on the canvas (toolbar button / command). */
  autoLayout(): void {
    this._layoutRequested.emit();
  }
  /**
   * The live cell widget to execute a cell in: this view's, or the notebook panel's on the same context.
   *
   * @param cellId - The cell id.
   * @returns The widget, or `undefined` when neither view has one (an output-only node with no
   * notebook panel open).
   *
   * @remarks
   * Nodes register their `Cell` widgets as they mount; with `outputOnlyNodes` on there is none, so
   * the notebook panel on the same context (`INotebookTracker.find`,
   * `@jupyterlab/apputils/src/widgettracker.ts:266`) supplies its widget for the cell instead.
   */
  cellWidget(cellId: string): Cell | undefined {
    const own = this._widgets.get(cellId);
    if (own) {
      return own;
    }
    const panel = this._notebookTracker.find(p => p.context === this.context);
    return panel?.content.widgets.find(c => c.model.id === cellId);
  }
  /**
   * Render the canvas, or nothing until the notebook model has loaded.
   *
   * @returns The {@link DagCanvas} element, or an empty `div` before `context.isReady`.
   */
  protected render(): JSX.Element {
    if (!this.context.isReady) {
      return <div />;
    }
    return (
      <DagCanvas
        graph={this.graph}
        nodeContext={this._nodeContext}
        settings={this.settings}
        layoutRequested={this._layoutRequested}
      />
    );
  }
  private _analyze(): void {
    this.executor.analyzeAll().catch(reason => console.error('jupyter-dag: analysis failed', reason));
  }
  private async _updateMimeTypes(): Promise<void> {
    const kernel = this.context.sessionContext.session?.kernel;
    if (!kernel) {
      return;
    }
    const info = await kernel.info.catch(() => null);
    if (!info) {
      return;
    }
    const mimeType = this._mimeTypeService.getMimeTypeByLanguage(info.language_info);
    for (const cell of this.graph.notebook.cells) {
      if (cell.type === 'code') {
        cell.mimeType = mimeType;
      }
    }
  }
  /**
   * Dispose the executor, client and graph model, then the widget.
   *
   * @remarks
   * The owned objects go first, while the context they refer to is still alive. `Widget.dispose`
   * (`@lumino/widgets/src/widget.ts:55`) then clears this widget's own signal connections, which
   * covers the `featuresChanged` and `kernelChanged` slots connected with `this`.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.executor.dispose();
    this.client.dispose();
    this.graph.dispose();
    super.dispose();
  }
  private _nodeContext: ICellNodeContext;
  private _mimeTypeService: IEditorMimeTypeService;
  private _notebookTracker: INotebookTracker;
  private _widgets = new Map<string, Cell>();
  private _layoutRequested = new Signal<this, void>(this);
}
/** Namespace for {@link DagPanel} statics. */
export namespace DagPanel {
  /** Options for creating a panel; the factory fills them in from its own options and the context. */
  export interface IOptions {
    /** The document context; its model is the notebook and its session context the kernel. */
    context: DocumentRegistry.IContext<INotebookModel>;
    /** Creates cell widgets; the notebook's content factory. */
    contentFactory: NotebookPanel.IContentFactory;
    /** Renders outputs; already cloned with the context's URL resolver. */
    rendermime: IRenderMimeRegistry;
    /** Maps a kernel's `language_info` to an editor mime type. */
    mimeTypeService: IEditorMimeTypeService;
    /** JupyterLab's cell executor. */
    cellExecutor: INotebookCellExecutor;
    /** The notebook tracker, to find the notebook panel on the same context. */
    notebookTracker: INotebookTracker;
    /** The settings, read at creation time. */
    settings: IDagSettings;
    /** Dialogs for kernel selection, passed to the executor. */
    sessionDialogs?: ISessionContext.IDialogs;
    /** The application translator. */
    translator?: ITranslator;
  }
}

/**
 * The second document view on a notebook context; its toolbar comes from `schema/plugin.json`.
 *
 * @remarks
 * `DocumentWidget` (`@jupyterlab/docregistry/src/default.ts:549`) is a `MainAreaWidget` with a
 * context: it wires the title to the path, the dirty state to the model, and the reveal spinner
 * to `context.ready`. The toolbar is not built here: the factory's `toolbarFactory` (from
 * `createToolbarFactory`, see `plugin.ts`) is applied by `ABCWidgetFactory.createNew`
 * (`default.ts:465-476`) right after this constructor returns.
 */
export class DagDocument extends DocumentWidget<DagPanel, INotebookModel> implements IDagDocument {
  /**
   * @param options - The content panel and context; see `DocumentWidget.IOptions`.
   */
  constructor(options: DagDocument.IOptions) {
    super(options);
    this.addClass('jp-DagDocument');
    this.title.icon = dagIcon;
  }
}
/** Namespace for {@link DagDocument} statics. */
export namespace DagDocument {
  /** The document widget options, with a {@link DagPanel} as content. */
  export type IOptions = DocumentWidget.IOptions<DagPanel, INotebookModel>;
}

/**
 * Creates a {@link DagDocument} for a notebook context; registered with the document registry
 * under the name `'DAG'` (`FACTORY_NAME` in `tokens.ts`).
 *
 * @remarks
 * `ABCWidgetFactory` (`@jupyterlab/docregistry/src/default.ts:317`) implements the registry's
 * widget-factory contract: `createNew` (`default.ts:465`) calls `createNewWidget`, applies the
 * toolbar factory (`default.ts:472`) and emits `widgetCreated` (`default.ts:476`), which the plugin
 * uses to add the widget to its tracker. `modelName` is passed as `'notebook'` on every
 * construction, which is what makes the document manager hand back the notebook panel's existing
 * context and model instead of a fresh one (see the module comment).
 *
 * The rendermime is cloned per document with the context's URL resolver, exactly as
 * `NotebookWidgetFactory` does (`@jupyterlab/notebook/src/widgetfactory.ts:91`), so relative
 * links and attachments in outputs resolve against the notebook's path.
 */
export class DagWidgetFactory extends ABCWidgetFactory<DagDocument, INotebookModel> {
  /**
   * @param options - Registry options plus the services every panel needs; see {@link DagWidgetFactory.IOptions}.
   */
  constructor(options: DagWidgetFactory.IOptions) {
    super({ ...options, modelName: 'notebook' });
    this._rendermime = options.rendermime;
    this._contentFactory = options.contentFactory;
    this._mimeTypeService = options.mimeTypeService;
    this._cellExecutor = options.cellExecutor;
    this._notebookTracker = options.notebookTracker;
    this._sessionDialogs = options.sessionDialogs;
    this._settings = options.settings;
  }
  /**
   * Create the panel and the document widget around it.
   *
   * @param context - The notebook context the registry resolved for the path.
   * @returns The new document widget, not yet added to the shell.
   */
  protected createNewWidget(context: DocumentRegistry.IContext<INotebookModel>): DagDocument {
    const rendermime = this._rendermime.clone({ resolver: context.urlResolver });
    const content = new DagPanel({
      context,
      contentFactory: this._contentFactory,
      rendermime,
      mimeTypeService: this._mimeTypeService,
      cellExecutor: this._cellExecutor,
      notebookTracker: this._notebookTracker,
      settings: this._settings(),
      sessionDialogs: this._sessionDialogs,
      translator: this.translator
    });
    return new DagDocument({ content, context, translator: this.translator });
  }
  private _rendermime: IRenderMimeRegistry;
  private _contentFactory: NotebookPanel.IContentFactory;
  private _mimeTypeService: IEditorMimeTypeService;
  private _cellExecutor: INotebookCellExecutor;
  private _notebookTracker: INotebookTracker;
  private _sessionDialogs?: ISessionContext.IDialogs;
  private _settings: () => IDagSettings;
}
/** Namespace for {@link DagWidgetFactory} statics. */
export namespace DagWidgetFactory {
  /** The registry's widget factory options plus what every panel needs. */
  export interface IOptions extends DocumentRegistry.IWidgetFactoryOptions<DagDocument> {
    /** The application rendermime; cloned per document. */
    rendermime: IRenderMimeRegistry;
    /** Creates cell widgets; the notebook's content factory. */
    contentFactory: NotebookPanel.IContentFactory;
    /** Maps a kernel's `language_info` to an editor mime type. */
    mimeTypeService: IEditorMimeTypeService;
    /** JupyterLab's cell executor. */
    cellExecutor: INotebookCellExecutor;
    /** The notebook tracker, to find the notebook panel on the same context. */
    notebookTracker: INotebookTracker;
    /** Read when a widget is created, so setting changes apply to the next DAG view. */
    settings: () => IDagSettings;
    /** Dialogs for kernel selection, passed to the executor. */
    sessionDialogs?: ISessionContext.IDialogs;
  }
}
