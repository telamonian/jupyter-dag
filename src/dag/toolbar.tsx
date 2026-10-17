/**
 * The DAG toolbar items that are widgets rather than commands: the new-cell type dropdown and
 * the execution indicator.
 *
 * Toolbar items named in `schema/plugin.json` without a `command` are built by factories
 * registered on `IToolbarWidgetRegistry` under the DAG factory name (`plugin.ts`); each factory
 * receives the `DagDocument`. The kernel-name button needs no code of its own:
 * `Toolbar.createKernelNameItem` from `@jupyterlab/apputils` is registered directly.
 *
 * @module
 */
import React from 'react';
import { ExecutionIndicator } from '@jupyterlab/notebook';
import type { INotebookModel, INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { nullTranslator } from '@jupyterlab/translation';
import type { ITranslator, TranslationBundle } from '@jupyterlab/translation';
import { HTMLSelect, ReactWidget } from '@jupyterlab/ui-components';
import type { Widget } from '@lumino/widgets';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { DagDocument, DagPanel } from './document';
import { NOTEBOOK_TRACKER_PLUGIN_ID, isDagCellType } from './tokens';

/** One indicator model per document context, shared by every DAG toolbar on that context. */
const indicatorModels = new WeakMap<DocumentRegistry.IContext<INotebookModel>, ExecutionIndicator.Model>();
/** The live indicator of each DAG document, so a toolbar rebuild can dispose the one it replaces. */
const indicators = new WeakMap<DagDocument, Widget>();

/**
 * The dropdown that picks the type of the next cell the "Add Cell" button inserts.
 *
 * @remarks
 * The notebook toolbar's `CellTypeSwitcher` (`@jupyterlab/notebook/src/default-toolbar.tsx:332`)
 * changes the type of the *selected* cells through `NotebookActions.changeCellType`
 * (`default-toolbar.tsx:352-360`), so it cannot pick a new cell's type; this widget reuses its
 * markup, an `HTMLSelect` (`@jupyterlab/ui-components/src/components/htmlselect.tsx:48`) whose
 * look comes from `.jp-HTMLSelect.jp-DefaultStyle`, and writes `DagPanel.newCellType` instead.
 */
export class CellTypeSelect extends ReactWidget {
  /**
   * @param panel - The panel whose `newCellType` the dropdown edits.
   * @param translator - The application translator.
   */
  constructor(panel: DagPanel, translator?: ITranslator) {
    super();
    this.addClass('jp-DagCellTypeSelect');
    this._panel = panel;
    this._trans = (translator ?? nullTranslator).load('jupyter-dag');
  }
  /**
   * Render the dropdown.
   *
   * @returns The `HTMLSelect` element showing the panel's current choice.
   */
  protected render(): JSX.Element {
    const trans = this._trans;
    return (
      <HTMLSelect
        className="jp-DagCellTypeSelect-dropdown"
        value={this._panel.newCellType}
        onChange={this._onChange}
        aria-label={trans.__('New cell type')}
        title={trans.__('Type of the next cell added to the DAG')}
        options={[
          { value: 'code', label: trans.__('Code') },
          { value: 'markdown', label: trans.__('Markdown') },
          { value: 'raw', label: trans.__('Raw') }
        ]}
      />
    );
  }
  private _onChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const { value } = event.target;
    if (isDagCellType(value)) {
      this._panel.newCellType = value;
      this.update();
    }
  };
  private _panel: DagPanel;
  private _trans: TranslationBundle;
}

/**
 * The execution indicator for the DAG toolbar: the busy/idle circle with progress.
 *
 * @param doc - The DAG document; its context's session is what the indicator follows.
 * @param notebooks - The notebook tracker, to find the notebook panel on the same context.
 * @param settings - The setting registry, for the user's display options.
 * @param translator - The application translator.
 * @returns The indicator widget.
 *
 * @remarks
 * After `ExecutionIndicator.createExecutionIndicatorItem`
 * (`@jupyterlab/notebook/src/executionindicator.tsx:650-698`) without its `NotebookPanel`
 * parameter. The indicator's model needs a `Notebook` widget as well as a session context
 * (`attachNotebook`, `executionindicator.tsx:342-347`), but uses it only as the key of the map
 * that holds the execution state (`:639-642`); the progress itself is counted from the session
 * kernel's messages (`:388-419`), which the DAG executor's runs produce like any other. So the
 * notebook panel on the same context is attached, now or when one opens, and until then the
 * indicator renders an empty element (`:236-249`). The user's `kernelStatus` display options
 * come from core's notebook tracker settings through `getSettingValue` (`:700-716`), as they do
 * for the notebook toolbar, except that the jump-to-cell button stays off: it would act on the
 * notebook panel, not on the DAG view.
 *
 * Lifetimes. `attachNotebook` connects the model to the kernel and the session context without a
 * `thisArg`, and `VDomRenderer.dispose` nulls the widget's model without disposing it, so a
 * model per indicator would stay subscribed to the kernel until the context is disposed, once per
 * DAG view ever opened. One model per context is therefore shared by every indicator on it and
 * attached at most once per notebook panel (`attachNotebook` ignores a `Notebook` it already
 * knows). And since the settings transformer rebuilds the toolbar on every change to this
 * plugin's settings, detaching rather than disposing the old items, the indicator a document had
 * before is disposed here when its replacement is made, which also runs the disconnects below.
 */
export function createExecutionIndicator(
  doc: DagDocument,
  notebooks: INotebookTracker,
  settings: ISettingRegistry,
  translator?: ITranslator
): Widget {
  indicators.get(doc)?.dispose();
  const indicator = new ExecutionIndicator(translator);
  indicators.set(doc, indicator);
  const { context } = doc;
  let model = indicatorModels.get(context);
  if (!model) {
    model = new ExecutionIndicator.Model();
    model.displayOption = { showOnToolBar: true, showProgress: true, showJumpToCell: false };
    indicatorModels.set(context, model);
  }
  indicator.model = model;
  const attach = (panel: NotebookPanel): void => {
    model.attachNotebook({ content: panel.content, context: context.sessionContext });
  };
  const existing = notebooks.find(panel => panel.context === context);
  if (existing) {
    attach(existing);
  }
  const onAdded = (_: unknown, panel: NotebookPanel): void => {
    if (panel.context === context) {
      attach(panel);
    }
  };
  notebooks.widgetAdded.connect(onAdded);
  indicator.disposed.connect(() => notebooks.widgetAdded.disconnect(onAdded));
  settings
    .load(NOTEBOOK_TRACKER_PLUGIN_ID)
    .then(loaded => {
      const update = (): void =>
        model.updateRenderOption({ ...ExecutionIndicator.getSettingValue(loaded), showJumpToCell: false });
      update();
      loaded.changed.connect(update);
      indicator.disposed.connect(() => loaded.changed.disconnect(update));
    })
    .catch(reason => console.warn('jupyter-dag: notebook tracker settings unavailable', reason));
  return indicator;
}
