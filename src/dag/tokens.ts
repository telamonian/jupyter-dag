import { Token } from '@lumino/coreutils';
import type { PartialJSONObject, ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { IWidgetTracker } from '@jupyterlab/apputils';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { ICellModel } from '@jupyterlab/cells';
import type { ISignal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';

export const PLUGIN_ID = '@telamonian/jupyter-dag:plugin'; // bound to schema/plugin.json
export const PLUGIN_ID_BASE = '@telamonian/jupyter-dag';
export const FACTORY_NAME = 'DAG';
export const METADATA_KEY = 'jupyter-dag';
export const TRACKER_NAMESPACE = 'jupyter-dag';

export namespace CommandIDs {
  export const open = 'jupyter-dag:open';
  export const runAll = 'jupyter-dag:run-all';
  export const runDownstream = 'jupyter-dag:run-downstream';
  export const runUpstream = 'jupyter-dag:run-upstream';
  export const autoLayout = 'jupyter-dag:auto-layout';
}

/** User settings declared in schema/plugin.json under PLUGIN_ID. */
export interface IDagSettings {
  layoutDirection: 'TB' | 'LR';
  maxZoom: number;
  outputOnlyNodes: boolean;
  analyzeChannel: 'shell' | 'control';
}
export const DEFAULT_SETTINGS: IDagSettings = {
  layoutDirection: 'TB',
  maxZoom: 1,
  outputOnlyNodes: false,
  analyzeChannel: 'shell'
};
export function readSettings(composite: ReadonlyPartialJSONObject): IDagSettings {
  return {
    layoutDirection: composite.layoutDirection === 'LR' ? 'LR' : 'TB',
    maxZoom: typeof composite.maxZoom === 'number' ? composite.maxZoom : DEFAULT_SETTINGS.maxZoom,
    outputOnlyNodes: composite.outputOnlyNodes === true,
    analyzeChannel: composite.analyzeChannel === 'control' ? 'control' : 'shell'
  };
}

/** Persisted per cell under cell.metadata['jupyter-dag']. Inbound edges only. */
export interface IDagCellMetadata extends PartialJSONObject {
  inputs: string[];
  position?: { x: number; y: number };
  width?: number;
  height?: number;
}
/** Persisted at notebook level under notebook.metadata['jupyter-dag']. */
export interface IDagNotebookMetadata extends PartialJSONObject {
  version: 1;
  direction?: 'TB' | 'LR';
  viewport?: { x: number; y: number; zoom: number };
}
export interface IWire {
  id: string;
  source: string;
  target: string;
}
export type DagNodeState = 'fresh' | 'stale' | 'queued' | 'running' | 'error';
export interface IDagGraphChange {
  type: 'edges' | 'nodes' | 'layout' | 'state';
  cellIds?: string[];
}

/** The seam the reactive plugin will consume; the DAG view uses the concrete DagGraphModel. */
export interface IDagGraphModel extends IDisposable {
  readonly notebook: INotebookModel;
  readonly changed: ISignal<IDagGraphModel, IDagGraphChange>;
  readonly cellIds: string[];
  readonly wires: IWire[];
  findCell(id: string): ICellModel | undefined;
  stateOf(cellId: string): DagNodeState;
}

export type IDagDocument = IDocumentWidget<Widget, INotebookModel>;
export type IDagTracker = IWidgetTracker<IDagDocument>;
export const IDagTracker = new Token<IDagTracker>(
  `${PLUGIN_ID_BASE}:IDagTracker`,
  'Tracker for open DAG views of notebooks.'
);

export interface IDagGraphModelFactory {
  (notebook: INotebookModel): IDagGraphModel;
}
export const IDagGraphModelFactory = new Token<IDagGraphModelFactory>(
  `${PLUGIN_ID_BASE}:IDagGraphModelFactory`,
  'Factory for DAG graph models over a notebook model.'
);

export function readCellMetadata(raw: ReadonlyPartialJSONObject | undefined): IDagCellMetadata {
  const inputs = Array.isArray(raw?.inputs) ? (raw!.inputs as string[]) : [];
  const out: IDagCellMetadata = { inputs: [...inputs] };
  // Only finite numbers survive: a non-finite coordinate serialises as null and would poison the canvas.
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
