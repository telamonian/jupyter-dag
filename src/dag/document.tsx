import React from 'react';
import { ABCWidgetFactory, DocumentWidget } from '@jupyterlab/docregistry';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { INotebookCellExecutor, INotebookModel, INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import type { ISessionContext } from '@jupyterlab/apputils';
import { LabIcon, ReactWidget } from '@jupyterlab/ui-components';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { IEditorMimeTypeService } from '@jupyterlab/codeeditor';
import type { Cell } from '@jupyterlab/cells';
import type { KernelMessage } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import type { ITranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import { DagCanvas } from './canvas';
import type { ICellNodeContext } from './cellnode';
import { DagGraphModel } from './wiring';
import { DagExecutor } from './executor';
import { DagKernelClient } from './protocol';
import type { IDagDocument, IDagSettings } from './tokens';

export const dagIcon = new LabIcon({
  name: 'jupyter-dag:dag',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161"><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="12" cy="19" r="3"/><path d="M6.5 7.5 10.5 16M17.5 7.5 13.5 16" stroke="#616161" stroke-width="2" fill="none"/></g></svg>'
});

/** The React Flow canvas as a Lumino widget; owns the graph model, kernel client and executor. */
export class DagPanel extends ReactWidget {
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
      findCell: id => this.graph.findCell(id),
      registerWidget: (id, cell) => {
        if (cell) {
          this._widgets.set(id, cell);
        } else {
          this._widgets.delete(id);
        }
      },
      onRunDownstream: id => void this.executor.run({ mode: 'downstream', roots: [id] })
    };
    // The client re-detects on kernel start, change and restart; analysis follows every detection.
    this.client.featuresChanged.connect(this._analyze, this);
    this.context.sessionContext.kernelChanged.connect(this._updateMimeTypes, this);
    // A kernel may already be running (a DAG view opened next to its notebook panel).
    void this.client.detectFeatures();
    void this._updateMimeTypes();
    // On layout restore the panel is attached (under the document spinner) before the notebook has loaded:
    // mount the canvas only once the model is populated, so React Flow never sees an empty graph.
    void this.context.ready.then(() => this.update());
  }
  readonly context: DocumentRegistry.IContext<INotebookModel>;
  readonly settings: IDagSettings;
  readonly graph: DagGraphModel;
  readonly client: DagKernelClient;
  readonly executor: DagExecutor;
  /** Re-run auto-layout on the canvas (toolbar button / command). */
  autoLayout(): void {
    this._layoutRequested.emit();
  }
  /** The live cell widget to execute: this view's, or the notebook panel's on the same context. */
  cellWidget(cellId: string): Cell | undefined {
    const own = this._widgets.get(cellId);
    if (own) {
      return own;
    }
    const panel = this._notebookTracker.find(p => p.context === this.context);
    return panel?.content.widgets.find(c => c.model.id === cellId);
  }
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
    // StaticNotebook does this in _onKernelChanged (widget.ts:703)
    const kernel = this.context.sessionContext.session?.kernel;
    if (!kernel) {
      return;
    }
    const info: KernelMessage.IInfoReply = await kernel.info.catch(() => undefined as never);
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
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.executor.dispose();
    this.client.dispose();
    this.graph.dispose();
    super.dispose(); // Widget.dispose clears this widget's signal connections
  }
  private _nodeContext: ICellNodeContext;
  private _mimeTypeService: IEditorMimeTypeService;
  private _notebookTracker: INotebookTracker;
  private _widgets = new Map<string, Cell>();
  private _layoutRequested = new Signal<this, void>(this);
}
export namespace DagPanel {
  export interface IOptions {
    context: DocumentRegistry.IContext<INotebookModel>;
    contentFactory: NotebookPanel.IContentFactory;
    rendermime: IRenderMimeRegistry;
    mimeTypeService: IEditorMimeTypeService;
    cellExecutor: INotebookCellExecutor;
    notebookTracker: INotebookTracker;
    settings: IDagSettings;
    sessionDialogs?: ISessionContext.IDialogs;
    translator?: ITranslator;
  }
}

/** The second document view on a notebook context; its toolbar comes from schema/plugin.json. */
export class DagDocument extends DocumentWidget<DagPanel, INotebookModel> implements IDagDocument {
  constructor(options: DagDocument.IOptions) {
    super(options);
    this.addClass('jp-DagDocument');
    this.title.icon = dagIcon;
  }
}
export namespace DagDocument {
  export type IOptions = DocumentWidget.IOptions<DagPanel, INotebookModel>;
}

export class DagWidgetFactory extends ABCWidgetFactory<DagDocument, INotebookModel> {
  constructor(options: DagWidgetFactory.IOptions) {
    super({ ...options, modelName: 'notebook' }); // modelName is load-bearing: share the notebook model
    this._rendermime = options.rendermime;
    this._contentFactory = options.contentFactory;
    this._mimeTypeService = options.mimeTypeService;
    this._cellExecutor = options.cellExecutor;
    this._notebookTracker = options.notebookTracker;
    this._sessionDialogs = options.sessionDialogs;
    this._settings = options.settings;
  }
  protected createNewWidget(context: DocumentRegistry.IContext<INotebookModel>): DagDocument {
    const rendermime = this._rendermime.clone({ resolver: context.urlResolver }); // as NotebookWidgetFactory does (widgetfactory.ts:85)
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
export namespace DagWidgetFactory {
  export interface IOptions extends DocumentRegistry.IWidgetFactoryOptions<DagDocument> {
    rendermime: IRenderMimeRegistry;
    contentFactory: NotebookPanel.IContentFactory;
    mimeTypeService: IEditorMimeTypeService;
    cellExecutor: INotebookCellExecutor;
    notebookTracker: INotebookTracker;
    /** Read when a widget is created, so setting changes apply to the next DAG view. */
    settings: () => IDagSettings;
    sessionDialogs?: ISessionContext.IDialogs;
  }
}
