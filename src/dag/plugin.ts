/**
 * The JupyterLab plugins: the DAG document view, and the graph-model factory other plugins can require.
 *
 * A JupyterLab plugin is an object with an `id`, the tokens it `requires` and takes as `optional`,
 * the token it `provides`, and an `activate` function; the application resolves the tokens from
 * the plugins that provide them and calls `activate(app, ...required, ...optional)` with the
 * optional ones as `null` when absent. Everything the DAG view needs from core arrives that way,
 * and everything it offers to others (the tracker, the graph-model factory) leaves that way.
 *
 * @module
 */
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
 * The DAG view plugin: registers the widget factory, tracks open views, and adds the commands.
 *
 * @remarks
 * Why it has the template's plugin id. `schema/plugin.json` is bound to {@link PLUGIN_ID}: its
 * `jupyter.lab.toolbars` block defines the notebook and DAG toolbars, `jupyter.lab.menus` the View
 * menu entry, and its properties are the settings, all attached to whichever plugin has this id.
 *
 * What each token is for. `INotebookTracker` finds the notebook panel on the same context (for
 * cell widgets and the open command's `currentWidget`); `IDocumentManager` opens notebooks as
 * DAGs; `IRenderMimeRegistry`, `IEditorServices` (its mime type service) and
 * `NotebookPanel.IContentFactory` are what building cell widgets needs; `INotebookCellExecutor`
 * runs cells; `ISettingRegistry` loads the settings. `IToolbarWidgetRegistry` is required rather
 * than optional because of the ordering below. Optional: `ILayoutRestorer` reopens DAG views on
 * reload, `ICommandPalette` lists the commands, `ISessionContextDialogs` provides the kernel
 * picker, `ITranslator` the translation bundle.
 *
 * Why the toolbar factory is created before the settings load. The schema declares
 * `jupyter.lab.transform: true`, which tells the settings registry that a plugin will transform
 * the schema before it can be used; `SettingRegistry.load`
 * (`@jupyterlab/settingregistry/src/settingregistry.ts:370`) therefore fails for this plugin until
 * a transformer is registered (`settingregistry.ts:726`, "has no transformers yet").
 * `createToolbarFactory` (`@jupyterlab/apputils/src/toolbar/factory.ts:252`) is what registers it:
 * through `setToolbarItems` (`factory.ts:65`) it installs a transformer that merges the schema's
 * toolbar definitions into the `toolbar` property (`factory.ts:123`) and then loads the settings
 * itself (`factory.ts:184`). Once that has run, `settingRegistry.load` resolves and its
 * `composite` carries the schema defaults; the factory reads them at each widget creation so a
 * settings change applies to the next DAG view.
 *
 * Tracking and restoring. The factory emits `widgetCreated` for every DAG view; the tracker
 * records it, and `tracker.save` on `pathChanged` keeps a renamed notebook restorable. The layout
 * restorer (`ILayoutRestorer.restore`, `@jupyterlab/application/src/layoutrestorer.ts:234`) saves
 * every tracked widget under `namespace:name` (`layoutrestorer.ts:253-256`) and, on the next
 * start, re-runs `command` with `args(widget)` for each: `docmanager:open` with `factory: 'DAG'`
 * reopens the notebook as a DAG.
 *
 * Commands. `open` calls `openOrReveal` (`@jupyterlab/docmanager/src/manager.ts:481`), which
 * reveals an existing DAG view for the path or opens one; the options (`IOpenOptions`,
 * `@jupyterlab/docregistry/src/registry.ts:1121`) place it split to the right of the notebook.
 * The three run commands share one table and read `args.cellId`, which the node toolbar passes
 * and the document toolbar does not. `isEnabled` is what the toolbar buttons grey out on.
 *
 * Translation. `translator.load('jupyter-dag')` (`ITranslator.load`,
 * `@jupyterlab/rendermime-interfaces/src/index.ts:757`) selects this extension's own domain;
 * until a language pack ships for it, every string comes back as written.
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
    const trans = translator.load('jupyter-dag');
    const tracker = new WidgetTracker<DagDocument>({ namespace: TRACKER_NAMESPACE });
    const toolbarFactory = createToolbarFactory(toolbarRegistry, settingRegistry, FACTORY_NAME, PLUGIN_ID, translator);
    const settings = await settingRegistry.load(PLUGIN_ID);

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

/**
 * The seam for the reactive plugin: how to get a graph model over any notebook model.
 *
 * @remarks
 * A separate plugin so that a consumer can require {@link IDagGraphModelFactory} without
 * activating the view plugin and its React Flow code. The factory is the plain constructor for
 * now; if two consumers ever need to share one graph model per notebook, this is where a cache
 * keyed by model would go.
 */
export const dagGraphModelPlugin: JupyterFrontEndPlugin<IDagGraphModelFactory> = {
  id: `${PLUGIN_ID_BASE}:graph-model`,
  description: 'Factory for DAG graph models (consumed by the reactive plugin).',
  autoStart: true,
  provides: IDagGraphModelFactory,
  activate: (): IDagGraphModelFactory => notebook => new DagGraphModel(notebook)
};
/** All plugins of the extension, in the order they are listed; the package's default export. */
export const dagPlugins: JupyterFrontEndPlugin<unknown>[] = [dagViewPlugin, dagGraphModelPlugin];
