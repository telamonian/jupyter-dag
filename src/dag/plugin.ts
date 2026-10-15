/**
 * The JupyterLab plugins: the DAG document view, and the graph-model factory other plugins can require.
 *
 * `activate` receives the `requires` tokens in order, then the `optional` ones, with `null` for any
 * that no plugin provides.
 *
 * @module
 */
import { ILayoutRestorer } from '@jupyterlab/application';
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import {
  ICommandPalette,
  IKernelStatusModel,
  ISessionContextDialogs,
  IToolbarWidgetRegistry,
  SessionContextDialogs,
  Toolbar,
  WidgetTracker,
  createToolbarFactory
} from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { INotebookCellExecutor, INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { IEditorServices } from '@jupyterlab/codeeditor';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { addIcon, refreshIcon, runIcon, stopIcon } from '@jupyterlab/ui-components';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { DagDocument, DagWidgetFactory, dagIcon } from './document';
import { FEATURE_ANALYZE } from './protocol';
import { CellTypeSelect, createExecutionIndicator } from './toolbar';
import { DagGraphModel } from './wiring';
import {
  CommandIDs,
  FACTORY_NAME,
  IDagGraphModelFactory,
  IDagTracker,
  PLUGIN_ID,
  PLUGIN_ID_BASE,
  TRACKER_NAMESPACE,
  isDagCellType,
  readSettings
} from './tokens';
import type { IDagRunOptions } from './executor';

/**
 * The DAG view plugin: registers the widget factory, tracks open views, and adds the commands.
 *
 * @remarks
 * Why the toolbar factory is created before the settings load. The schema declares
 * `jupyter.lab.transform: true`, which tells the settings registry that a plugin will transform
 * the schema before it can be used; `SettingRegistry.load`
 * (`@jupyterlab/settingregistry/src/settingregistry.ts:370`) therefore fails for this plugin until
 * a transformer is registered (`settingregistry.ts:726`, "has no transformers yet").
 * `createToolbarFactory` (`@jupyterlab/apputils/src/toolbar/factory.ts:252`) registers it:
 * through `setToolbarItems` (`factory.ts:65`) it installs a transformer that merges the schema's
 * toolbar definitions into the `toolbar` property (`factory.ts:123`) and then loads the settings
 * itself (`factory.ts:184`). Once that has run, `settingRegistry.load` resolves and its
 * `composite` carries the schema defaults.
 *
 * Why it has the template's plugin id. {@link PLUGIN_ID} is the id `schema/plugin.json` is bound
 * to; that schema holds the notebook and DAG toolbars, the View menu entry and the settings.
 *
 * Toolbar items. `cellType`, `kernelName` and `executionProgress` have no command, so they are
 * registered as factories on `IToolbarWidgetRegistry` (`addFactory`,
 * `@jupyterlab/apputils/src/tokens.ts:363-367`) under the DAG factory name, before the toolbar
 * factory is created: a listed item with neither command nor factory renders as an empty
 * `CommandToolbarButton` (`@jupyterlab/apputils/src/toolbar/registry.ts:63-72`). Each factory
 * receives the `DagDocument` that `ABCWidgetFactory.createNew` hands to `setToolbar`
 * (`@jupyterlab/docregistry/src/default.ts:465-476`). The add, interrupt and restart buttons are
 * commands, like core's `panel.json` items; core's `notebook:*` commands cannot be listed here
 * because they act on, and focus, the notebook tracker's current panel.
 *
 * What each token is for. `INotebookTracker` finds the notebook panel on the same context (for
 * cell widgets and the open command's `currentWidget`); `IDocumentManager` opens notebooks as
 * DAGs; `IRenderMimeRegistry`, `IEditorServices` (its mime type service) and
 * `NotebookPanel.IContentFactory` build cell widgets; `INotebookCellExecutor` runs cells;
 * `ISettingRegistry` loads the settings. `IToolbarWidgetRegistry` is required rather than optional
 * because of the ordering above. Optional: `ILayoutRestorer` reopens DAG views on reload,
 * `ICommandPalette` lists the commands, `ISessionContextDialogs` provides the kernel picker,
 * `ITranslator` the translation bundle.
 *
 * Tracking and restoring. The factory emits `widgetCreated` for every DAG view; the tracker
 * records it, and `tracker.save` on `pathChanged` keeps a renamed notebook restorable. The same
 * hook re-evaluates `addCell` once the context is ready: a restored view builds its toolbar before
 * the file has loaded, and `CommandToolbarButton` only re-reads `isEnabled` on
 * `commandChanged`, which the application fires on tab switches, so without the notification the
 * button would stay greyed out until the user changed tabs. The layout
 * restorer (`ILayoutRestorer.restore`, `@jupyterlab/application/src/layoutrestorer.ts:234`) saves
 * every tracked widget under `namespace:name` (`layoutrestorer.ts:253-256`) and, on the next
 * start, re-runs `command` with `args(widget)` for each: `docmanager:open` with `factory: 'DAG'`
 * reopens the notebook as a DAG.
 *
 * Commands. `open` calls `openOrReveal` (`@jupyterlab/docmanager/src/manager.ts:481`), which
 * reveals an existing DAG view for the path or opens one; the options (`IOpenOptions`,
 * `@jupyterlab/docregistry/src/registry.ts:1121`) place it split to the right of the notebook.
 * The three run commands share one table and read `args.cellId`, which the node toolbar passes
 * and the document toolbar does not. `autoWire` runs `DagExecutor.autoWire`, enabled only once
 * the kernel client has found the analysis feature, which is why `widgetCreated` re-evaluates it
 * on `featuresChanged`. `addCell` forwards to `DagPanel.addCell`, with
 * `args.cellType` when it names a cell type; `interruptKernel` calls the kernel connection's
 * `interrupt` (`@jupyterlab/services/src/kernel/kernel.ts:205`); `restartKernel` goes through
 * `ISessionContextDialogs.restart` (`@jupyterlab/apputils/src/sessioncontext.tsx:337`), which
 * confirms first unless the `skipKernelRestartDialog` setting is on and starts the previous
 * kernel again when none is running. The toolbar buttons grey out on `isEnabled`. Those three
 * commands take core's `args.toolbar` convention: the schema passes it for the toolbar items,
 * which belong to a document, while from the palette the DAG view has to be the shell's current
 * widget, since the tracker's current widget outlives its focus. Interrupt and restart are not
 * in the palette, where core's notebook entries already reach the same kernel. `undo` and `redo`
 * call the shared model's own `undo` and `redo`, as `NotebookActions.undo` does
 * (`@jupyterlab/notebook/src/actions.tsx:1666-1674`), so one `Z` reverts one DAG edit (a wire, a
 * move, a cell) or one notebook edit alike; the schema binds `Z` and `Shift Z` to them while focus
 * is inside a `DagPanel` but not in an editor or input, the DAG counterpart of the notebook's
 * command-mode bindings.
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
    toolbarRegistry.addFactory<DagDocument>(
      FACTORY_NAME,
      'cellType',
      doc => new CellTypeSelect(doc.content, translator)
    );
    toolbarRegistry.addFactory<DagDocument>(FACTORY_NAME, 'kernelName', doc =>
      Toolbar.createKernelNameItem(doc.context.sessionContext, sessionDialogs ?? undefined, translator)
    );
    toolbarRegistry.addFactory<DagDocument>(FACTORY_NAME, 'executionProgress', doc =>
      createExecutionIndicator(doc, notebookTracker, settingRegistry, translator)
    );
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
      // The toolbar is built before the file has loaded; re-evaluate `isEnabled` once it has.
      void widget.context.ready.then(() => commands.notifyCommandChanged(CommandIDs.addCell));
      // Auto-wire needs the kernel's analysis, which is only known once features are detected.
      widget.content.client.featuresChanged.connect(() => commands.notifyCommandChanged(CommandIDs.autoWire));
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
      label: trans.__('Auto-layout'),
      caption: trans.__('Lay the nodes out from the wires'),
      isEnabled: () => !!tracker.currentWidget,
      execute: () => tracker.currentWidget?.content.autoLayout()
    });
    // Toolbar buttons act on their own document; from the palette the DAG view has to be the current widget.
    const isActive = (args: ReadonlyPartialJSONObject): boolean =>
      !!tracker.currentWidget && (args.toolbar === true || tracker.currentWidget === app.shell.currentWidget);
    commands.addCommand(CommandIDs.addCell, {
      label: trans.__('Add Cell'),
      caption: trans.__('Add a cell after the selected cell, or at the end of the notebook'),
      icon: addIcon,
      isEnabled: args => isActive(args) && !!tracker.currentWidget?.context.isReady,
      execute: (args: ReadonlyPartialJSONObject) => {
        tracker.currentWidget?.content.addCell(isDagCellType(args.cellType) ? args.cellType : undefined);
      }
    });
    commands.addCommand(CommandIDs.interruptKernel, {
      label: trans.__('Interrupt Kernel'),
      caption: trans.__('Interrupt the kernel'),
      icon: stopIcon,
      isEnabled: isActive,
      execute: () => tracker.currentWidget?.context.sessionContext.session?.kernel?.interrupt()
    });
    const dialogs = sessionDialogs ?? new SessionContextDialogs({ translator });
    commands.addCommand(CommandIDs.restartKernel, {
      label: trans.__('Restart Kernel…'),
      caption: trans.__('Restart the kernel'),
      icon: refreshIcon,
      isEnabled: isActive,
      execute: async () => {
        const sessionContext = tracker.currentWidget?.context.sessionContext;
        if (!sessionContext) {
          return;
        }
        try {
          await dialogs.restart(sessionContext); // starts the previous kernel again when none is running, as core does
        } catch (reason) {
          console.warn('jupyter-dag: kernel restart failed', reason); // "No kernel to restart" when none ever ran
        }
      }
    });
    commands.addCommand(CommandIDs.autoWire, {
      label: trans.__('Auto-wire'),
      caption: trans.__('Replace every wire with the dependencies the kernel finds between cells'),
      isEnabled: args => isActive(args) && !!tracker.currentWidget?.content.client.features.has(FEATURE_ANALYZE),
      execute: () => tracker.currentWidget?.content.executor.autoWire()
    });
    commands.addCommand(CommandIDs.undo, {
      label: trans.__('Undo DAG Edit'),
      caption: trans.__('Undo the last change to the notebook'),
      isEnabled: args => isActive(args) && !!tracker.currentWidget?.context.model.sharedModel.canUndo(),
      execute: () => tracker.currentWidget?.context.model.sharedModel.undo()
    });
    commands.addCommand(CommandIDs.redo, {
      label: trans.__('Redo DAG Edit'),
      caption: trans.__('Redo the last undone change to the notebook'),
      isEnabled: args => isActive(args) && !!tracker.currentWidget?.context.model.sharedModel.canRedo(),
      execute: () => tracker.currentWidget?.context.model.sharedModel.redo()
    });
    if (palette) {
      const category = trans.__('Notebook Operations');
      [
        CommandIDs.open,
        CommandIDs.runAll,
        CommandIDs.autoWire,
        CommandIDs.autoLayout,
        CommandIDs.addCell,
        CommandIDs.undo,
        CommandIDs.redo
      ].forEach(command => palette.addItem({ command, category }));
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

/**
 * Shows the current DAG view's kernel in the status bar.
 *
 * @remarks
 * The status-bar kernel item (core's `apputils-extension` `kernel-status` plugin) asks every
 * registered session provider for the current widget's session context and shows the first
 * answer as "kernel | status"; a click opens the kernel picker. The notebook extension's provider
 * answers only for notebook panels, so DAG tabs showed nothing. This provider answers for tracked
 * DAG views with the shared session context. `IKernelStatusModel`
 * (`@jupyterlab/apputils/src/tokens.ts:55-73`) is optional because the status bar can be
 * disabled.
 */
export const dagKernelStatusPlugin: JupyterFrontEndPlugin<void> = {
  id: `${PLUGIN_ID_BASE}:kernel-status`,
  description: 'Shows the kernel of the current DAG view in the status bar.',
  autoStart: true,
  requires: [IDagTracker],
  optional: [IKernelStatusModel],
  activate: (_app: JupyterFrontEnd, tracker: IDagTracker, kernelStatus: IKernelStatusModel | null): void => {
    kernelStatus?.addSessionProvider(
      widget => (widget && tracker.find(doc => doc === widget)?.context.sessionContext) ?? null
    );
  }
};
/**
 * The package's default export: every plugin JupyterLab activates for this extension, so a new
 * plugin has to be added here.
 */
export const dagPlugins: JupyterFrontEndPlugin<unknown>[] = [dagViewPlugin, dagGraphModelPlugin, dagKernelStatusPlugin];
