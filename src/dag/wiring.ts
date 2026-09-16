import type { ICellModel } from '@jupyterlab/cells';
import type { CellList, INotebookModel } from '@jupyterlab/notebook';
import type { IObservableList } from '@jupyterlab/observables';
import type { CellChange, IMapChange, ISharedCell } from '@jupyter/ydoc';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { find } from '@lumino/algorithm';
import { Signal } from '@lumino/signaling';
import type { ISignal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import { METADATA_KEY, readCellMetadata } from './tokens';
import type {
  DagNodeState,
  IDagCellMetadata,
  IDagGraphChange,
  IDagGraphModel,
  IDagNotebookMetadata,
  IWire
} from './tokens';

// Graph algorithms derived from ipyflow frontend/labextension/src/graph/closure.ts (BSD-3-Clause, Stephen Macke).

export function wireId(source: string, target: string): string {
  return `${source}->${target}`;
}

export function getCellMetadata(cell: ICellModel): IDagCellMetadata {
  return readCellMetadata(cell.getMetadata(METADATA_KEY) as ReadonlyPartialJSONObject | undefined);
}
export function setCellMetadata(cell: ICellModel, value: IDagCellMetadata): void {
  cell.setMetadata(METADATA_KEY, value); // ydoc skips deep-equal values; never pass undefined (it deletes the key)
}
export function getNotebookMetadata(model: INotebookModel): IDagNotebookMetadata {
  return (model.getMetadata(METADATA_KEY) as IDagNotebookMetadata | undefined) ?? { version: 1 };
}
export function setNotebookMetadata(model: INotebookModel, value: IDagNotebookMetadata): void {
  model.setMetadata(METADATA_KEY, value);
}
/** Wires whose source cell still exists; inputs pointing at deleted cells are ignored, not rewritten. */
export function collectWires(model: INotebookModel): IWire[] {
  const ids = new Set(Array.from(model.cells, c => c.id));
  const wires: IWire[] = [];
  for (const cell of model.cells) {
    for (const source of getCellMetadata(cell).inputs) {
      if (ids.has(source)) {
        wires.push({ id: wireId(source, cell.id), source, target: cell.id });
      }
    }
  }
  return wires;
}
export function addWire(model: INotebookModel, source: string, target: string): IWire | null {
  const cell = find(model.cells, c => c.id === target);
  if (!cell || source === target || wouldCreateCycle(collectWires(model), source, target)) {
    return null;
  }
  const meta = getCellMetadata(cell);
  setCellMetadata(cell, { ...meta, inputs: [...new Set([...meta.inputs, source])] });
  return { id: wireId(source, target), source, target };
}
export function removeWire(model: INotebookModel, source: string, target: string): void {
  const cell = find(model.cells, c => c.id === target);
  if (!cell) {
    return;
  }
  const meta = getCellMetadata(cell);
  setCellMetadata(cell, { ...meta, inputs: meta.inputs.filter(id => id !== source) });
}

export function downstreamOf(start: Iterable<string>, wires: IWire[], inclusive: boolean): Set<string> {
  const out = new Set<string>();
  const stack = [...start];
  const seeds = new Set(stack);
  while (stack.length) {
    const id = stack.pop()!;
    for (const w of wires) {
      if (w.source === id && !out.has(w.target)) {
        out.add(w.target);
        stack.push(w.target);
      }
    }
  }
  if (inclusive) {
    seeds.forEach(s => out.add(s));
  } else {
    seeds.forEach(s => out.delete(s));
  }
  return out;
}
export function upstreamOf(start: Iterable<string>, wires: IWire[], inclusive: boolean): Set<string> {
  const reversed = wires.map(w => ({ id: w.id, source: w.target, target: w.source }));
  return downstreamOf(start, reversed, inclusive);
}
export function wouldCreateCycle(wires: IWire[], source: string, target: string): boolean {
  return source === target || downstreamOf([target], wires, true).has(source);
}
/** Kahn's algorithm; ties broken by `cellIds` order (document order). */
export function topologicalOrder(cellIds: string[], wires: IWire[]): string[] {
  const ids = new Set(cellIds);
  const indeg = new Map<string, number>(cellIds.map(id => [id, 0]));
  for (const w of wires) {
    if (ids.has(w.source) && ids.has(w.target)) {
      indeg.set(w.target, (indeg.get(w.target) ?? 0) + 1);
    }
  }
  const out: string[] = [];
  const ready = cellIds.filter(id => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const w of wires) {
      if (w.source !== id || !ids.has(w.target)) {
        continue;
      }
      const d = (indeg.get(w.target) ?? 1) - 1;
      indeg.set(w.target, d);
      if (d === 0) {
        ready.push(w.target);
        ready.sort((a, b) => cellIds.indexOf(a) - cellIds.indexOf(b));
      }
    }
  }
  return out;
}

/**
 * Fan-in of the notebook model's signals into one `changed` signal, plus the ephemeral
 * per-node state (fresh / stale / queued / running / error). Wires and cell ids are always
 * read from the notebook; nothing here writes back to the document.
 */
export class DagGraphModel implements IDagGraphModel, IDisposable {
  constructor(notebook: INotebookModel) {
    this.notebook = notebook;
    notebook.cells.changed.connect(this._onCellsChanged, this);
    notebook.metadataChanged.connect(this._onNotebookMetadataChanged, this);
    for (const cell of notebook.cells) {
      this._track(cell);
    }
  }
  readonly notebook: INotebookModel;
  get changed(): ISignal<this, IDagGraphChange> {
    return this._changed;
  }
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  get cellIds(): string[] {
    return Array.from(this.notebook.cells, c => c.id);
  }
  get wires(): IWire[] {
    return collectWires(this.notebook);
  }
  findCell(id: string): ICellModel | undefined {
    return this._cells.get(id);
  }
  stateOf(cellId: string): DagNodeState {
    return this._state.get(cellId) ?? 'fresh';
  }
  setState(cellId: string, s: DagNodeState): void {
    this._state.set(cellId, s);
    this._changed.emit({ type: 'state', cellIds: [cellId] });
  }
  markStale(ids: Iterable<string>): void {
    const changed: string[] = [];
    for (const id of ids) {
      if (this._state.get(id) !== 'stale') {
        this._state.set(id, 'stale');
        changed.push(id);
      }
    }
    if (changed.length) {
      this._changed.emit({ type: 'state', cellIds: changed });
    }
  }
  private _track(cell: ICellModel): void {
    this._cells.set(cell.id, cell);
    cell.metadataChanged.connect(this._onCellMetadataChanged, this);
    cell.sharedModel.changed.connect(this._onSharedCellChanged, this);
  }
  private _onCellsChanged(_: CellList, args: IObservableList.IChangedArgs<ICellModel>): void {
    // CellList reports removals with `oldValues` full of undefined (the models are already disposed),
    // so reconcile against the live list instead of the change args.
    const live = new Set(this.cellIds);
    for (const id of [...this._cells.keys()]) {
      if (!live.has(id)) {
        this._cells.delete(id);
      }
    }
    args.newValues.forEach(c => this._track(c));
    this._changed.emit({ type: 'nodes' });
  }
  private _onCellMetadataChanged(cell: ICellModel, change: IMapChange): void {
    if (change.key !== METADATA_KEY) {
      return;
    }
    // Position and size writes share the key with the wires; only report an edge change when inputs differ.
    const before = readCellMetadata(change.oldValue as ReadonlyPartialJSONObject | undefined).inputs;
    const after = readCellMetadata(change.newValue as ReadonlyPartialJSONObject | undefined).inputs;
    const same = before.length === after.length && before.every((id, i) => id === after[i]);
    this._changed.emit({ type: same ? 'layout' : 'edges', cellIds: [cell.id] });
  }
  private _onSharedCellChanged(sender: ISharedCell, change: CellChange): void {
    if (change.sourceChange) {
      this.markStale([sender.getId()]);
    } // NOT contentChanged: that fires on output writes too
  }
  private _onNotebookMetadataChanged(_: INotebookModel, change: IMapChange): void {
    if (change.key === METADATA_KEY) {
      this._changed.emit({ type: 'layout' });
    }
  }
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
  }
  private _changed = new Signal<this, IDagGraphChange>(this);
  private _cells = new Map<string, ICellModel>();
  private _state = new Map<string, DagNodeState>();
  private _isDisposed = false;
}
