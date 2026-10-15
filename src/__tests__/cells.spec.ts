/**
 * Unit tests for `dag/cells.ts` and `removeAllWires`, over a real `NotebookModel`.
 *
 * The model-backed tests check the undo grouping (one `undo` per operation) and the
 * `deletedCells` bookkeeping, which pure wire lists cannot show.
 */
import { NotebookModel } from '@jupyterlab/notebook';
import type { YNotebook } from '@jupyter/ydoc';
import type { ICodeCellModel } from '@jupyterlab/cells';
import { clearOutputs, deleteCell, insertCell, insertIndexAfter } from '../dag/cells';
import { DagGraphModel, addWire, collectWires, removeAllWires } from '../dag/wiring';
import { METADATA_KEY } from '../dag/tokens';

describe('insertIndexAfter', () => {
  const ids = ['a', 'b', 'c'];
  it('appends when nothing is selected', () => {
    expect(insertIndexAfter(ids, [])).toBe(3);
  });
  it('inserts after the last selected cell in document order', () => {
    expect(insertIndexAfter(ids, ['c', 'a'])).toBe(3);
    expect(insertIndexAfter(ids, ['b'])).toBe(2);
  });
  it('ignores unknown ids', () => {
    expect(insertIndexAfter(ids, ['zzz'])).toBe(3);
    expect(insertIndexAfter(ids, ['zzz', 'a'])).toBe(1);
  });
});

/** A notebook with one code cell per source, whose undo manager keeps every transaction separate. */
function makeNotebook(sources: string[]): NotebookModel {
  const model = new NotebookModel();
  (model.sharedModel as YNotebook).undoManager.captureTimeout = 0; // one stack item per transaction
  model.sharedModel.insertCells(
    0,
    sources.map(source => ({ cell_type: 'code', source }))
  );
  return model;
}

/** Close the undo manager's capture window, so the next change is its own undo step. */
function settle(model: NotebookModel): void {
  (model.sharedModel as YNotebook).undoManager.stopCapturing();
}

describe('cell operations on the notebook model', () => {
  it('inserts a cell with its DAG metadata as one undo step', () => {
    const model = makeNotebook(['a', 'b']);
    settle(model);
    const id = insertCell(model, 1, 'markdown', { x: 12, y: 34 });
    const cell = model.cells.get(1);
    expect(cell.id).toBe(id);
    expect(cell.type).toBe('markdown');
    expect(cell.getMetadata(METADATA_KEY)).toEqual({ inputs: [], position: { x: 12, y: 34 } });
    model.sharedModel.undo();
    expect(model.cells.length).toBe(2);
  });

  it('deletes a cell, records it for the kernel, and restores its wires on undo', () => {
    const model = makeNotebook(['a', 'b']);
    const graph = new DagGraphModel(model);
    const [a, b] = graph.cellIds;
    addWire(graph, a, b);
    settle(model);
    expect(deleteCell(model, a)).toBe(true);
    expect(model.deletedCells).toEqual([a]);
    expect(graph.cellIds).toEqual([b]);
    expect(collectWires(model)).toEqual([]);
    model.sharedModel.undo();
    expect(graph.cellIds).toEqual([a, b]);
    expect(collectWires(model)).toEqual([{ id: `${a}->${b}`, source: a, target: b }]);
    graph.dispose();
  });

  it('refuses a cell marked deletable: false', () => {
    const model = makeNotebook(['a']);
    model.cells.get(0).setMetadata('deletable', false);
    expect(deleteCell(model, model.cells.get(0).id)).toBe(false);
    expect(model.deletedCells).toEqual([]);
  });

  it('replaces the last cell with an empty code cell, undone as one step', () => {
    const model = makeNotebook(['only']);
    const id = model.cells.get(0).id;
    settle(model);
    expect(deleteCell(model, id)).toBe(true);
    expect(model.cells.length).toBe(1);
    expect(model.cells.get(0).sharedModel.getSource()).toBe('');
    model.sharedModel.undo();
    expect(model.cells.length).toBe(1);
    expect(model.cells.get(0).id).toBe(id);
    expect(model.cells.get(0).sharedModel.getSource()).toBe('only');
  });

  it('removes every wire of a cell as one undo step', () => {
    const model = makeNotebook(['a', 'b', 'c']);
    const graph = new DagGraphModel(model);
    const [a, b, c] = graph.cellIds;
    addWire(graph, a, b);
    addWire(graph, b, c);
    settle(model);
    removeAllWires(graph, b);
    expect(graph.wires).toEqual([]);
    expect(graph.stateOf(c)).toBe('stale');
    model.sharedModel.undo();
    expect(graph.wires.map(w => w.id)).toEqual([`${a}->${b}`, `${b}->${c}`]);
    graph.dispose();
  });

  it('clears outputs and the execution count', () => {
    const model = makeNotebook(['print(1)']);
    const cell = model.cells.get(0) as ICodeCellModel;
    cell.executionCount = 3;
    cell.outputs.add({ output_type: 'stream', name: 'stdout', text: '1\n' });
    clearOutputs(cell);
    expect(cell.outputs.length).toBe(0);
    expect(cell.executionCount).toBeNull();
  });
});
