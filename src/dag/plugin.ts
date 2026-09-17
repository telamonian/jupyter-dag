import { ILayoutRestorer } from '@jupyterlab/application';
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import {
  ICommandPalette,
  ISessionContextDialogs,
  IToolbarWidgetRegistry,
  WidgetTracker,
  createToolbarFactory
} from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { INotebookCellExecutor, INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { IEditorServices } from '@jupyterlab/codeeditor';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { runIcon } from '@jupyterlab/ui-components';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { DagDocument, DagWidgetFactory, dagIcon } from './document';
import { DagGraphModel } from './wiring';
import {
  CommandIDs,
  FACTORY_NAME,
  IDagGraphModelFactory,
  IDagTracker,
  PLUGIN_ID,
  PLUGIN_ID_BASE,
  TRACKER_NAMESPACE,
  readSettings
} from './tokens';
import type { IDagRunOptions } from './executor';

/**
 * The DAG view. Takes the template's plugin id so schema/plugin.json binds to it: the notebook
 * and DAG toolbars, the View menu entry, the shortcut and the settings all come from the schema.
 */
export const dagViewPlugin: JupyterFrontEndPlugin<IDagTracker> = {
  id: PLUGIN_ID,
  description: 'A DAG view on the notebook model: cells as nodes, wires as execution order.',
  autoStart: true,
  requires: [
    INotebookTracker,
    IDocumentManager,
    IRenderMimeRegistry,
    IEditorServices,
    NotebookPanel.IContentFactory,
    INotebookCellExecutor,
    ISettingRegistry,
    IToolbarWidgetRegistry
  ],
  optional: [ILayoutRestorer, ICommandPalette, ISessionContextDialogs, ITranslator],
  provides: IDagTracker,
  activate: async (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    docManager: IDocumentManager,
    rendermime: IRenderMimeRegistry,
    editorServices: IEditorServices,
    contentFactory: NotebookPanel.IContentFactory,
    cellExecutor: INotebookCellExecutor,
    settingRegistry: ISettingRegistry,
    toolbarRegistry: IToolbarWidgetRegistry,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null,
    sessionDialogs: ISessionContextDialogs | null,
    translator_: ITranslator | null
  ): Promise<IDagTracker> => {
    const translator = translator_ ?? nullTranslator;
    const trans = translator.load('jupyter-dag'); // this extension's own translation domain
    const tracker = new WidgetTracker<DagDocument>({ namespace: TRACKER_NAMESPACE });
    // The schema declares `jupyter.lab.transform`, so the settings cannot load until the toolbar
    // factory has registered its transformer: create it first.
    const toolbarFactory = createToolbarFactory(toolbarRegistry, settingRegistry, FACTORY_NAME, PLUGIN_ID, translator);
    const settings = await settingRegistry.load(PLUGIN_ID); // schema defaults fill `composite`

    const factory = new DagWidgetFactory({
      name: FACTORY_NAME,
      label: trans.__('DAG View'),
      fileTypes: ['notebook'],
      preferKernel: true,
      canStartKernel: true,
      toolbarFactory,
      translator,
      rendermime,
      contentFactory,
      mimeTypeService: editorServices.mimeTypeService,
      cellExecutor,
      notebookTracker,
      settings: () => readSettings(settings.composite),
      sessionDialogs: sessionDialogs ?? undefined
    });
    factory.widgetCreated.connect((_, widget) => {
      void tracker.add(widget);
      widget.context.pathChanged.connect(() => void tracker.save(widget));
    });
    app.docRegistry.addWidgetFactory(factory);
    if (restorer) {
      void restorer.restore(tracker, {
        command: 'docmanager:open',
        args: w => ({ path: w.context.path, factory: FACTORY_NAME }),
        name: w => w.context.path,
        when: app.serviceManager.ready
      });
    }

    const { commands } = app;
    commands.addCommand(CommandIDs.open, {
      label: trans.__('Open DAG View'),
      caption: trans.__('Open the current notebook as a DAG'),
      icon: dagIcon,
      isEnabled: () => !!notebookTracker.currentWidget,
      execute: (args: ReadonlyPartialJSONObject) => {
        const current = notebookTracker.currentWidget;
        const path = (args.path as string | undefined) ?? current?.context.path;
        if (!path) {
          return;
        }
        return docManager.openOrReveal(path, FACTORY_NAME, undefined, { ref: current?.id, mode: 'split-right' });
      }
    });
    const runCommands: { id: string; label: string; mode: IDagRunOptions['mode'] }[] = [
      { id: CommandIDs.runAll, label: trans.__('Run DAG'), mode: 'all' },
      { id: CommandIDs.runDownstream, label: trans.__('Run Cell and Downstream'), mode: 'downstream' },
      { id: CommandIDs.runUpstream, label: trans.__('Run Upstream and Cell'), mode: 'upstream' }
    ];
    for (const { id, label, mode } of runCommands) {
      commands.addCommand(id, {
        label,
        icon: runIcon,
        isEnabled: () => !!tracker.currentWidget,
        execute: (args: ReadonlyPartialJSONObject) => {
          const cellId = args.cellId as string | undefined;
          const roots = cellId ? [cellId] : [];
          return tracker.currentWidget?.content.executor.run({ mode, roots });
        }
      });
    }
    commands.addCommand(CommandIDs.autoLayout, {
      label: trans.__('Auto-layout DAG'),
      isEnabled: () => !!tracker.currentWidget,
      execute: () => tracker.currentWidget?.content.autoLayout()
    });
    if (palette) {
      const category = trans.__('Notebook Operations');
      [CommandIDs.open, CommandIDs.runAll, CommandIDs.autoLayout].forEach(command =>
        palette.addItem({ command, category })
      );
    }
    return tracker;
  }
};

/** The seam for the reactive plugin: how to get a graph model over any notebook model. */
export const dagGraphModelPlugin: JupyterFrontEndPlugin<IDagGraphModelFactory> = {
  id: `${PLUGIN_ID_BASE}:graph-model`,
  description: 'Factory for DAG graph models (consumed by the reactive plugin).',
  autoStart: true,
  provides: IDagGraphModelFactory,
  activate: (): IDagGraphModelFactory => notebook => new DagGraphModel(notebook)
};
export const dagPlugins: JupyterFrontEndPlugin<unknown>[] = [dagViewPlugin, dagGraphModelPlugin];
