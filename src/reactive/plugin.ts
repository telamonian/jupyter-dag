/**
 * The two plugins that make the notebook view reactive.
 *
 * Why two. The notebook tracker plugin requires `INotebookCellExecutor`
 * (`@jupyterlab/notebook-extension/src/index.ts:417-421`), and the plugin registry refuses a
 * dependency cycle (`ensureNoCycle`, `@lumino/coreutils/src/plugins.ts:720`), so the plugin that
 * provides the token cannot itself depend on the tracker. The provider plugin has no dependencies
 * at all; the other plugin needs the tracker, the toolbar registry and the settings, and the two
 * share the registry of controllers through this module's scope.
 *
 * Why the core provider is disabled. Lumino lets a later provider replace an earlier one without
 * complaint, but `package.json` lists `@jupyterlab/notebook-extension:cell-executor` under
 * `jupyterlab.disabledExtensions`, which the server folds into the page config
 * (`jupyterlab_server/config.py:171-204`), so only one executor is ever registered.
 *
 * @module
 */
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ISessionContextDialogs, IToolbarWidgetRegistry } from '@jupyterlab/apputils';
import { INotebookCellExecutor, INotebookTracker } from '@jupyterlab/notebook';
import type { NotebookPanel } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator } from '@jupyterlab/translation';
import { PLUGIN_ID, PLUGIN_ID_BASE, readSettings } from '../dag/tokens';
import { ReactiveRegistry } from './controller';
import { createReactiveCellExecutor } from './executor';
import { createReactiveButton } from './toolbar';

/** The widget factory name of notebook panels, the key of their toolbar in `jupyter.lab.toolbars`. */
const NOTEBOOK_FACTORY_NAME = 'Notebook';
/** The toolbar item name, matching `schema/plugin.json`. */
const TOOLBAR_ITEM = 'reactive';

/** The one registry both plugins use. */
const registry = new ReactiveRegistry();

/**
 * Provides the `INotebookCellExecutor` token: the reactive executor, which defers to the core one
 * for notebooks that have no controller.
 */
export const reactiveExecutorPlugin: JupyterFrontEndPlugin<INotebookCellExecutor> = {
  id: `${PLUGIN_ID_BASE}:cell-executor`,
  description: 'Provides the notebook cell executor, with reactive execution for kernels that analyse cells.',
  autoStart: true,
  provides: INotebookCellExecutor,
  activate: (): INotebookCellExecutor => createReactiveCellExecutor(registry)
};

/**
 * Attaches a controller to every notebook panel and adds the reactivity switch to its toolbar.
 *
 * @remarks
 * The toolbar factory is registered at activation, before any notebook opens, so the button is
 * placed by the toolbar definition's rank (`createToolbarFactory` sorts items by rank across
 * every plugin's `jupyter.lab.toolbars`, `@jupyterlab/apputils/src/toolbar/factory.ts:86-119`):
 * rank 999 puts it after core's spacer (100) and before `kernelName` (1000), and the debugger
 * then inserts its bug button before `kernelName` (`@jupyterlab/debugger/src/handler.ts:59`), to
 * the right of ours. The settings of the view plugin supply `analyzeChannel`; loading them can
 * fail when that plugin is disabled, in which case the default channel is used.
 */
export const reactiveNotebookPlugin: JupyterFrontEndPlugin<void> = {
  id: `${PLUGIN_ID_BASE}:reactive`,
  description: 'Reactive execution in the notebook view, behind a toolbar switch.',
  autoStart: true,
  requires: [INotebookTracker, IToolbarWidgetRegistry],
  optional: [ISettingRegistry, ISessionContextDialogs, ITranslator],
  activate: (
    _app: JupyterFrontEnd,
    tracker: INotebookTracker,
    toolbarRegistry: IToolbarWidgetRegistry,
    settingRegistry: ISettingRegistry | null,
    sessionDialogs: ISessionContextDialogs | null,
    translator: ITranslator | null
  ): void => {
    registry.options.sessionDialogs = sessionDialogs ?? undefined;
    registry.options.translator = translator ?? undefined;
    toolbarRegistry.addFactory<NotebookPanel>(NOTEBOOK_FACTORY_NAME, TOOLBAR_ITEM, panel =>
      createReactiveButton(registry.ensure(panel), translator ?? undefined)
    );
    tracker.widgetAdded.connect((_, panel) => {
      registry.ensure(panel);
    });
    tracker.forEach(panel => registry.ensure(panel));
    settingRegistry
      ?.load(PLUGIN_ID)
      .then(settings => {
        registry.options.analyzeChannel = readSettings(settings.composite).analyzeChannel;
      })
      .catch(reason => console.warn('jupyter-dag: reactive plugin could not load the settings', reason));
  }
};

/** The plugins this module contributes, in the order they are exported. */
export const reactivePlugins: JupyterFrontEndPlugin<unknown>[] = [reactiveExecutorPlugin, reactiveNotebookPlugin];
