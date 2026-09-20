/**
 * Wires between cells: how they are stored in the notebook, the graph algorithms over them, and
 * the {@link DagGraphModel} that turns the notebook model's signals into one change signal.
 *
 * A wire is a directed edge "target runs after source". It is stored on the target cell only,
 * as an entry of `inputs` in the cell's `jupyter-dag` metadata ({@link IDagCellMetadata}), so the
 * notebook file, not this module, is the source of truth; every function here reads the wires
 * back from the cells. The graph algorithms are derived from ipyflow's
 * `frontend/labextension/src/graph/closure.ts` (BSD-3-Clause, Stephen Macke).
 *
 * @module
 */
import type { ICellModel } from '@jupyterlab/cells';
import type { CellList, INotebookModel } from '@jupyterlab/notebook';
import type { IObservableList } from '@jupyterlab/observables';
import type { CellChange, IMapChange, ISharedCell } from '@jupyter/ydoc';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ArrayExt, find } from '@lumino/algorithm';
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

/**
 * The id of the wire from `source` to `target`, also used as the React Flow edge id.
 *
 * @param source - The upstream cell id.
 * @param target - The downstream cell id.
 * @returns `${source}->${target}`, unique per ordered pair.
 */
export function wireId(source: string, target: string): string {
  return `${source}->${target}`;
}

/**
 * Read a cell's `jupyter-dag` metadata, sanitised.
 *
 * @param cell - The cell model.
 * @returns The metadata with `inputs` always present; see {@link readCellMetadata}.
 *
 * @remarks
 * `ICellModel.getMetadata` (`@jupyterlab/cells/src/model.ts:351`) reads straight from the shared
 * model, so this always reflects the document, including edits made by another client.
 */
export function getCellMetadata(cell: ICellModel): IDagCellMetadata {
  return readCellMetadata(cell.getMetadata(METADATA_KEY) as ReadonlyPartialJSONObject | undefined);
}
/**
 * Merge `patch` into a cell's `jupyter-dag` metadata and write it back.
 *
 * @param cell - The cell model.
 * @param patch - The fields to change; the others keep their stored values.
 *
 * @remarks
 * Metadata values are stored whole under their key, so a change to one field is a read, merge and
 * write of the object. Two properties of the setter matter here. `CellModel.setMetadata`
 * (`@jupyterlab/cells/src/model.ts:361-367`) deletes the key when the value is `undefined`, which
 * is why the whole object is always passed. And `YBaseCell.setMetadata`
 * (`@jupyter/ydoc/src/ycell.ts:522-524`) compares the new value with `JSONExt.deepEqual` and
 * returns without writing when nothing changed, so writing an unchanged object emits no
 * `metadataChanged`. Each write is its own Yjs transaction (`ycell.ts:526`) unless a caller wraps
 * several in `sharedModel.transact`, which also makes them one undo step.
 */
export function updateCellMetadata(cell: ICellModel, patch: Partial<IDagCellMetadata>): void {
  cell.setMetadata(METADATA_KEY, { ...getCellMetadata(cell), ...patch });
}
/**
 * Read the notebook-level `jupyter-dag` metadata.
 *
 * @param model - The notebook model.
 * @returns The stored value, or `{ version: 1 }` when the notebook has none.
 */
export function getNotebookMetadata(model: INotebookModel): IDagNotebookMetadata {
  return (model.getMetadata(METADATA_KEY) as IDagNotebookMetadata | undefined) ?? { version: 1 };
}
/**
 * Merge `patch` into the notebook-level `jupyter-dag` metadata and write it back.
 *
 * @param model - The notebook model.
 * @param patch - The fields to change.
 *
 * @remarks
 * `INotebookModel.setMetadata` (`@jupyterlab/notebook/src/model.ts:293`) forwards to
 * `YNotebook.setMetadata` (`@jupyter/ydoc/src/ynotebook.ts:348`), with the same deep-equal skip
 * as the cell setter.
 */
export function updateNotebookMetadata(model: INotebookModel, patch: Partial<IDagNotebookMetadata>): void {
  model.setMetadata(METADATA_KEY, { ...getNotebookMetadata(model), ...patch });
}
/**
 * Collect every wire whose source cell still exists.
 *
 * @param model - The notebook model.
 * @returns The wires, in document order of their targets.
 *
 * @remarks
 * An `inputs` entry that names a deleted cell is ignored, not rewritten: undoing the deletion
 * brings the cell back with its id, and the wire with it. The cost is one metadata read per cell;
 * {@link DagGraphModel.wires} caches the result.
 */
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
/**
 * Add a wire, unless it would make a cycle or the target does not exist.
 *
 * @param graph - The graph model, for the cell lookup and the current wires.
 * @param source - The upstream cell id.
 * @param target - The downstream cell id.
 * @returns The new wire, or `null` when nothing was written. Adding a wire that already exists
 * writes an unchanged `inputs` list, which the metadata setter drops, and still returns the wire.
 */
export function addWire(graph: DagGraphModel, source: string, target: string): IWire | null {
  const cell = graph.findCell(target);
  if (!cell || wouldCreateCycle(graph.wires, source, target)) {
    return null;
  }
  const { inputs } = getCellMetadata(cell);
  updateCellMetadata(cell, { inputs: [...new Set([...inputs, source])] });
  return { id: wireId(source, target), source, target };
}
/**
 * Remove a wire; a no-op if the target does not exist or has no such input.
 *
 * @param graph - The graph model, for the cell lookup.
 * @param source - The upstream cell id.
 * @param target - The downstream cell id.
 */
export function removeWire(graph: DagGraphModel, source: string, target: string): void {
  const cell = graph.findCell(target);
  if (cell) {
    updateCellMetadata(cell, { inputs: getCellMetadata(cell).inputs.filter(id => id !== source) });
  }
}

/**
 * Adjacency list: source id to target ids.
 *
 * @param wires - The wires.
 * @returns A map that answers "which cells run after this one" in constant time.
 */
function successors(wires: IWire[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const w of wires) {
    const targets = next.get(w.source);
    if (targets) {
      targets.push(w.target);
    } else {
      next.set(w.source, [w.target]);
    }
  }
  return next;
}
/**
 * Every cell reachable from `start` by following wires forward.
 *
 * @param start - The cells to start from.
 * @param wires - The wires to follow.
 * @param inclusive - Whether the start cells themselves are part of the result.
 * @returns The reachable cell ids, unordered.
 *
 * @remarks
 * A depth-first walk over `successors`; the visited set makes it terminate on a cycle even
 * though {@link addWire} refuses to create one.
 */
export function downstreamOf(start: Iterable<string>, wires: IWire[], inclusive: boolean): Set<string> {
  const next = successors(wires);
  const out = new Set<string>();
  const stack = [...start];
  const seeds = new Set(stack);
  while (stack.length) {
    for (const target of next.get(stack.pop()!) ?? []) {
      if (!out.has(target)) {
        out.add(target);
        stack.push(target);
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
/**
 * Every cell from which `start` is reachable: {@link downstreamOf} over the reversed wires.
 *
 * @param start - The cells to start from.
 * @param wires - The wires to follow backwards.
 * @param inclusive - Whether the start cells themselves are part of the result.
 * @returns The cell ids upstream of the start cells, unordered.
 */
export function upstreamOf(start: Iterable<string>, wires: IWire[], inclusive: boolean): Set<string> {
  const reversed = wires.map(w => ({ id: w.id, source: w.target, target: w.source }));
  return downstreamOf(start, reversed, inclusive);
}
/**
 * Whether adding the wire `source` to `target` would close a cycle.
 *
 * @param wires - The existing wires.
 * @param source - The upstream cell id of the wire to add.
 * @param target - The downstream cell id of the wire to add.
 * @returns True when `target` already reaches `source` (or the two are the same cell).
 *
 * @remarks
 * The canvas calls this from React Flow's `isValidConnection` on every pointer move while a wire
 * is being dragged, which is why {@link DagGraphModel.wires} is cached.
 */
export function wouldCreateCycle(wires: IWire[], source: string, target: string): boolean {
  return source === target || downstreamOf([target], wires, true).has(source);
}
/**
 * Order cells so that every wire's source comes before its target.
 *
 * @param cellIds - The cells to order, in document order; wires to cells outside this list are
 * ignored, so a subgraph run does not wait for cells that are not part of it.
 * @param wires - The wires.
 * @returns The same ids, topologically sorted; among cells that are ready at the same time,
 * document order wins.
 *
 * @remarks
 * Kahn's algorithm: repeatedly emit a cell with no unemitted upstream cells, then decrement the
 * in-degree of its targets. Re-sorting the ready list by document rank after each step is what
 * makes the result deterministic and notebook-like. `topologicSort` from `@lumino/algorithm`
 * (`@lumino/algorithm/src/sort.ts:37`) is not used because it takes only edges, so cells without
 * wires would drop out, and it has no tie-break. A cycle cannot occur (see {@link addWire}); if
 * one did, its cells would never become ready and would be left out of the result.
 */
export function topologicalOrder(cellIds: string[], wires: IWire[]): string[] {
  const rank = new Map<string, number>(cellIds.map((id, i) => [id, i]));
  const next = successors(wires.filter(w => rank.has(w.source) && rank.has(w.target)));
  const indeg = new Map<string, number>(cellIds.map(id => [id, 0]));
  for (const targets of next.values()) {
    for (const t of targets) {
      indeg.set(t, indeg.get(t)! + 1);
    }
  }
  const out: string[] = [];
  const ready = cellIds.filter(id => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const t of next.get(id) ?? []) {
      const d = indeg.get(t)! - 1;
      indeg.set(t, d);
      if (d === 0) {
        ready.push(t);
      }
    }
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
  }
  return out;
}

/**
 * Fan-in of the notebook model's signals into one `changed` signal, plus the ephemeral per-node
 * execution state.
 *
 * @remarks
 * Three signals feed it. `CellList.changed` (`@jupyterlab/notebook/src/celllist.ts:38`) reports
 * cells added, removed or moved. `ICellModel.metadataChanged`
 * (`@jupyterlab/cells/src/model.ts:266`, args `IMapChange`, `@jupyter/ydoc/src/api.ts:720`)
 * reports metadata writes, of which only a change to `inputs` is a wire change; position and size
 * writes share the key and are filtered out. `ISharedCell.changed` (`@jupyter/ydoc/src/ycell.ts:210`)
 * with a `sourceChange` (`api.ts:749`, set at `ycell.ts:608`) reports an edit to the cell's
 * source, which marks the cell stale; `ICellModel.contentChanged` is not used for that because it
 * also fires when outputs are written, which would mark a cell stale as it runs.
 *
 * Wires and cell ids are always read from the notebook (with `wires` cached until a change
 * invalidates it), and the class writes nothing back to the document; the state map is the only
 * thing it owns, and it is not persisted.
 */
export class DagGraphModel implements IDagGraphModel, IDisposable {
  /**
   * @param notebook - The notebook model to observe; every cell already in it is tracked at once.
   */
  constructor(notebook: INotebookModel) {
    this.notebook = notebook;
    notebook.cells.changed.connect(this._onCellsChanged, this);
    for (const cell of notebook.cells) {
      this._track(cell);
    }
  }
  /** The notebook model the graph is a view of. */
  readonly notebook: INotebookModel;
  /** Emitted after every change to cells, wires or node state. */
  get changed(): ISignal<this, IDagGraphChange> {
    return this._changed;
  }
  /** Whether {@link DagGraphModel.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /** Cell ids in document order, read from the cell list on every call. */
  get cellIds(): string[] {
    return Array.from(this.notebook.cells, c => c.id);
  }
  /**
   * Every wire whose source and target both exist.
   *
   * @remarks
   * Cached, because the canvas reads it on every pointer move while a wire is being dragged; the
   * cache is dropped when the cell list changes or a cell's `inputs` change.
   */
  get wires(): IWire[] {
    return (this._wires ??= collectWires(this.notebook));
  }
  /**
   * Look a cell model up by id.
   *
   * @param id - The cell id.
   * @returns The model, or `undefined`.
   *
   * @remarks
   * `CellList` has no lookup by id, only by index, so this is a linear `find`
   * (`@lumino/algorithm/src/find.ts:43`); notebooks are small enough for that.
   */
  findCell(id: string): ICellModel | undefined {
    return find(this.notebook.cells, c => c.id === id);
  }
  /**
   * The execution state of a cell.
   *
   * @param cellId - The cell id.
   * @returns The state, `'fresh'` for a cell never mentioned.
   */
  stateOf(cellId: string): DagNodeState {
    return this._state.get(cellId) ?? 'fresh';
  }
  /**
   * Set a cell's execution state and announce it.
   *
   * @param cellId - The cell id.
   * @param s - The new state.
   */
  setState(cellId: string, s: DagNodeState): void {
    this._state.set(cellId, s);
    this._changed.emit({ type: 'state', cellIds: [cellId] });
  }
  /**
   * Mark cells stale, announcing only those that were not stale already.
   *
   * @param ids - The cell ids.
   */
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
    cell.metadataChanged.connect(this._onCellMetadataChanged, this);
    cell.sharedModel.changed.connect(this._onSharedCellChanged, this);
  }
  /**
   * Track new cells, prune state for removed ones, and announce a `'nodes'` change.
   *
   * @remarks
   * `CellList` fills `oldValues` of a removal with `undefined`
   * (`@jupyterlab/notebook/src/celllist.ts:147-152`) because it disposes a cell model as soon as
   * its shared cell is deleted (`celllist.ts:121`), so removed cells cannot be read from the
   * change and the state map is reconciled against the live list instead. Disposing a model also
   * drops its signal connections, so nothing has to be disconnected here.
   */
  private _onCellsChanged(_: CellList, args: IObservableList.IChangedArgs<ICellModel>): void {
    args.newValues.forEach(c => this._track(c));
    const live = new Set(this.cellIds);
    for (const id of this._state.keys()) {
      if (!live.has(id)) {
        this._state.delete(id);
      }
    }
    this._wires = null;
    this._changed.emit({ type: 'nodes' });
  }
  /**
   * Announce an `'edges'` change when a cell's `inputs` changed; ignore other metadata writes.
   *
   * @remarks
   * Position and size writes share the metadata key with the wires, so old and new `inputs` are
   * compared (`ArrayExt.shallowEqual`, `@lumino/algorithm/src/array.ts:643`) and the wires cache
   * is dropped only when they differ.
   */
  private _onCellMetadataChanged(cell: ICellModel, change: IMapChange): void {
    if (change.key !== METADATA_KEY) {
      return;
    }
    const before = readCellMetadata(change.oldValue as ReadonlyPartialJSONObject | undefined).inputs;
    const after = readCellMetadata(change.newValue as ReadonlyPartialJSONObject | undefined).inputs;
    if (ArrayExt.shallowEqual(before, after)) {
      return;
    }
    this._wires = null;
    this._changed.emit({ type: 'edges', cellIds: [cell.id] });
  }
  private _onSharedCellChanged(sender: ISharedCell, change: CellChange): void {
    if (change.sourceChange) {
      this.markStale([sender.getId()]);
    }
  }
  /**
   * Disconnect from the notebook model.
   *
   * @remarks
   * `Signal.clearData(this)` (`@lumino/signaling/src/index.ts:259`) removes every connection in
   * which this object is the sender or the `thisArg`, which covers the cell-list and per-cell
   * connections made with `connect(..., this)`.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
  }
  private _changed = new Signal<this, IDagGraphChange>(this);
  private _state = new Map<string, DagNodeState>();
  private _wires: IWire[] | null = null;
  private _isDisposed = false;
}
