/**
 * The names, ids and shapes the DAG plugins share, and the tokens other plugins can require.
 *
 * This module is the public API: `src/index.ts` re-exports it, and nothing in it imports the view
 * code, so a plugin that wants the tracker or the graph-model factory can depend on it without
 * pulling in React Flow. Everything persisted in the notebook file is declared here too
 * ({@link IDagCellMetadata}, {@link IDagNotebookMetadata}), so the on-disk format has one home.
 *
 * @module
 */
import { Token } from '@lumino/coreutils';
import type { PartialJSONObject, ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { IWidgetTracker } from '@jupyterlab/apputils';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { ICellModel } from '@jupyterlab/cells';
import type { ISignal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';

/**
 * The id of the view plugin, and the id `schema/plugin.json` is bound to.
 *
 * @remarks
 * The settings registry looks a schema up by the id of the plugin that owns it, and the
 * `jupyter.lab.toolbars`, `jupyter.lab.menus` and `jupyter.lab.shortcuts` blocks in that schema
 * apply to whatever plugin has this id. The template chose `<package name>:plugin`; keeping it
 * means the schema, the settings and the toolbar definitions all stay attached to the DAG view.
 */
export const PLUGIN_ID = '@telamonian/jupyter-dag:plugin';
/** The npm package name, used as the prefix of every other plugin and token id. */
export const PLUGIN_ID_BASE = '@telamonian/jupyter-dag';
/** The widget factory name: what `docmanager:open` takes as `factory` to open a notebook as a DAG. */
export const FACTORY_NAME = 'DAG';
/** The key under which cell and notebook metadata are stored (`cell.metadata['jupyter-dag']`). */
export const METADATA_KEY = 'jupyter-dag';
/** The `WidgetTracker` namespace; also the prefix of the ids the layout restorer saves. */
export const TRACKER_NAMESPACE = 'jupyter-dag';

/** Command ids registered by the view plugin; the schema's toolbar and menu entries refer to them. */
export namespace CommandIDs {
  /** Open the current notebook as a DAG, split to the right. */
  export const open = 'jupyter-dag:open';
  /** Run every cell in wire order. */
  export const runAll = 'jupyter-dag:run-all';
  /** Run a cell and everything downstream of it (`args.cellId`). */
  export const runDownstream = 'jupyter-dag:run-downstream';
  /** Run everything upstream of a cell, then the cell (`args.cellId`). */
  export const runUpstream = 'jupyter-dag:run-upstream';
  /** Re-run the automatic layout of the current DAG view. */
  export const autoLayout = 'jupyter-dag:auto-layout';
}

/** Layout direction: top-to-bottom or left-to-right, as dagre spells `rankdir`. */
export type LayoutDirection = 'TB' | 'LR';
/** The kernel channel `analyze_request` is sent on. */
export type AnalyzeChannel = 'shell' | 'control';

/**
 * User settings declared in `schema/plugin.json` under {@link PLUGIN_ID}; the schema supplies the defaults.
 *
 * @remarks
 * Read once per DAG view, when the view is created; a change applies to the next view opened.
 */
export interface IDagSettings {
  /** Direction of the automatic layout, unless the notebook remembers one. */
  layoutDirection: LayoutDirection;
  /** Upper bound of the canvas zoom; 1 keeps cell text at its normal size. */
  maxZoom: number;
  /** Show only outputs in code cell nodes instead of a second editor on the same model. */
  outputOnlyNodes: boolean;
  /** Where {@link AnalyzeChannel | analyze requests} go. */
  analyzeChannel: AnalyzeChannel;
}
/**
 * Narrow the settings registry's composite (JSON) to {@link IDagSettings}.
 *
 * @param composite - `ISettings.composite` (`@jupyterlab/settingregistry/src/tokens.ts:511`): the
 * user's values merged over the schema defaults, as untyped JSON.
 * @returns Typed settings; a value of the wrong type falls back to the schema's default.
 */
export function readSettings(composite: ReadonlyPartialJSONObject): IDagSettings {
  return {
    layoutDirection: composite.layoutDirection === 'LR' ? 'LR' : 'TB',
    maxZoom: typeof composite.maxZoom === 'number' ? composite.maxZoom : 1,
    outputOnlyNodes: composite.outputOnlyNodes === true,
    analyzeChannel: composite.analyzeChannel === 'control' ? 'control' : 'shell'
  };
}

/**
 * What is persisted per cell under `cell.metadata['jupyter-dag']`.
 *
 * @remarks
 * Wires are stored on their target only, as `inputs`, so each wire exists once and deleting a
 * cell removes its inbound wires with it; wires whose source cell is gone are ignored when read.
 * Position and size are stored so the layout survives reload. The interface extends
 * `PartialJSONObject` (`@lumino/coreutils/src/json.ts:68`) because metadata values have to be
 * JSON: the shared model keeps them in a Yjs map.
 */
export interface IDagCellMetadata extends PartialJSONObject {
  /** Ids of the cells this cell depends on: one entry per inbound wire. */
  inputs: string[];
  /** Node position on the canvas, top-left corner in canvas coordinates. */
  position?: {
    /** Horizontal offset in canvas pixels. */
    x: number;
    /** Vertical offset in canvas pixels. */
    y: number;
  };
  /** Node width after a manual resize. */
  width?: number;
  /** Node height after a manual resize. */
  height?: number;
}
/** What is persisted at notebook level under `notebook.metadata['jupyter-dag']`. */
export interface IDagNotebookMetadata extends PartialJSONObject {
  /** Format version, for migrating the metadata later. */
  version: 1;
  /** The layout direction the user last chose for this notebook. */
  direction?: LayoutDirection;
  /** The canvas viewport (pan and zoom) at the last move, restored on open. */
  viewport?: {
    /** Horizontal pan. */
    x: number;
    /** Vertical pan. */
    y: number;
    /** Zoom factor; 1 is natural size. */
    zoom: number;
  };
}
/** A directed edge from one cell to another: the target runs after the source. */
export interface IWire {
  /** `${source}->${target}`; also the React Flow edge id. */
  id: string;
  /** The upstream cell id. */
  source: string;
  /** The downstream cell id. */
  target: string;
}
/**
 * The per-node execution state the DAG view shows.
 *
 * @remarks
 * `fresh` after a successful run (or before any run); `stale` when the cell's source or an
 * upstream cell changed since; `queued` while a run is scheduled; `error` when the run failed or
 * the cell had no widget to run in. This state is not persisted.
 */
export type DagNodeState = 'fresh' | 'stale' | 'queued' | 'error';
/** What changed in a graph model: the cell list, the wires, or the per-node execution state of `cellIds`. */
export interface IDagGraphChange {
  /** `'nodes'` for cells added, removed or moved; `'edges'` for wires; `'state'` for {@link DagNodeState}. */
  type: 'nodes' | 'edges' | 'state';
  /** For `'edges'` and `'state'`, the cells concerned. */
  cellIds?: string[];
}

/**
 * The seam the reactive plugin will consume; the DAG view uses the concrete `DagGraphModel`.
 *
 * @remarks
 * Everything a consumer needs to schedule runs: the cells, the wires between them, a change
 * signal, and the ephemeral execution state. Wires and cell ids are read from the notebook model
 * on every access, so the model is never out of date with the document.
 */
export interface IDagGraphModel extends IDisposable {
  /** The notebook model the graph is a view of. */
  readonly notebook: INotebookModel;
  /** Emitted after every change to cells, wires or node state. */
  readonly changed: ISignal<IDagGraphModel, IDagGraphChange>;
  /** Cell ids in document order. */
  readonly cellIds: string[];
  /** Every wire whose source and target both exist. */
  readonly wires: IWire[];
  /**
   * Look a cell model up by id.
   *
   * @param id - The cell id.
   * @returns The model, or `undefined` if no cell has that id.
   */
  findCell(id: string): ICellModel | undefined;
  /**
   * The execution state of a cell; `'fresh'` for a cell never mentioned.
   *
   * @param cellId - The cell id.
   */
  stateOf(cellId: string): DagNodeState;
}

/** A DAG view: a document widget over a notebook model (`IDocumentWidget`, `@jupyterlab/docregistry/src/registry.ts:1703`). */
export type IDagDocument = IDocumentWidget<Widget, INotebookModel>;
/** The tracker of open DAG views (`IWidgetTracker`, `@jupyterlab/apputils/src/widgettracker.ts:18`). */
export type IDagTracker = IWidgetTracker<IDagDocument>;
/**
 * The token under which the view plugin provides its tracker.
 *
 * @remarks
 * A `Token` (`@lumino/coreutils/src/token.ts:18`) is a typed identity: a plugin lists it under
 * `provides`, another under `requires` or `optional`, and the application passes the provided
 * value to the requiring plugin's `activate`. The name and type alias share a name on purpose,
 * the JupyterLab convention that lets `IDagTracker` be both the runtime token and the type.
 */
export const IDagTracker = new Token<IDagTracker>(
  `${PLUGIN_ID_BASE}:IDagTracker`,
  'Tracker for open DAG views of notebooks.'
);

/** Makes a graph model for any notebook model; what the reactive plugin will call. */
export interface IDagGraphModelFactory {
  (notebook: INotebookModel): IDagGraphModel;
}
/** The token under which the graph-model plugin provides its factory. */
export const IDagGraphModelFactory = new Token<IDagGraphModelFactory>(
  `${PLUGIN_ID_BASE}:IDagGraphModelFactory`,
  'Factory for DAG graph models over a notebook model.'
);

/**
 * Turn whatever is stored under the metadata key into a well-formed {@link IDagCellMetadata}.
 *
 * @param raw - The stored value, or `undefined` for a cell that has none.
 * @returns A fresh object with `inputs` always present and only finite numbers kept.
 *
 * @remarks
 * Metadata can be edited by hand, come from another version, or carry a coordinate that was
 * `NaN` when written: `JSON.stringify` turns `NaN` and `Infinity` into `null`, and a `null`
 * position reaches React Flow as a node with no numeric position, which breaks the layout maths
 * for every node. Checking `Number.isFinite` on the way in keeps that out of the canvas.
 */
export function readCellMetadata(raw: ReadonlyPartialJSONObject | undefined): IDagCellMetadata {
  const inputs = Array.isArray(raw?.inputs) ? (raw!.inputs as string[]) : [];
  const out: IDagCellMetadata = { inputs: [...inputs] };
  const pos = raw?.position as { x?: unknown; y?: unknown } | undefined;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    out.position = { x: pos.x as number, y: pos.y as number };
  }
  if (Number.isFinite(raw?.width)) {
    out.width = raw!.width as number;
  }
  if (Number.isFinite(raw?.height)) {
    out.height = raw!.height as number;
  }
  return out;
}
