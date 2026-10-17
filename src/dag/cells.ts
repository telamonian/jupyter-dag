/**
 * Cell operations on the notebook model that the DAG view performs without a `Notebook` widget.
 *
 * `NotebookActions.insertBelow`, `deleteCells` and `clearOutputs` take a `Notebook` widget:
 * `insertBelow` inserts after the widget's active cell with the widget's default cell type
 * (`@jupyterlab/notebook/src/actions.tsx:560-570`), and the other two return early without an
 * active cell (`:501`, `:1792-1795`). The `Private` helpers they delegate to are not exported. The
 * functions here mirror their shared-model bodies for one cell at a time, so a DAG node can add,
 * remove and clear cells with the same undo and kernel bookkeeping the notebook panel has.
 *
 * @module
 */
import type { CodeCell, ICodeCellModel } from '@jupyterlab/cells';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { XYPosition } from '@xyflow/react';
import { METADATA_KEY } from './tokens';
import type { DagCellType, IDagCellMetadata } from './tokens';

/**
 * The index at which a new cell goes: right after the last selected cell, or at the end.
 *
 * @param cellIds - Every cell id, in document order.
 * @param selectedIds - The selected cells; ids not in `cellIds` are ignored.
 * @returns An index into `cellIds`, `cellIds.length` when nothing is selected.
 */
export function insertIndexAfter(cellIds: readonly string[], selectedIds: Iterable<string>): number {
  let last = -1;
  for (const id of selectedIds) {
    last = Math.max(last, cellIds.indexOf(id));
  }
  return last < 0 ? cellIds.length : last + 1;
}

/**
 * Insert a cell with its DAG metadata, in one undoable transaction.
 *
 * @param model - The notebook model.
 * @param index - Where the cell goes in the document.
 * @param type - The cell type.
 * @param position - Where its node goes on the canvas.
 * @returns The new cell's id.
 *
 * @remarks
 * `ISharedNotebook.insertCell` (`@jupyter/ydoc/src/ynotebook.ts:198`) creates the cell and inserts
 * it in one transaction (`ynotebook.ts:213-233`), so cell, metadata and position are one undo
 * step, and the canvas's first look at the new cell already finds its position. A code cell is
 * marked `trusted`, as `NotebookActions.insertBelow` marks the cells it creates
 * (`@jupyterlab/notebook/src/actions.tsx:574-581`).
 */
export function insertCell(model: INotebookModel, index: number, type: DagCellType, position: XYPosition): string {
  const dag: IDagCellMetadata = { inputs: [], position: { x: position.x, y: position.y } };
  const cell = model.sharedModel.insertCell(index, {
    cell_type: type,
    metadata: { ...(type === 'code' ? { trusted: true } : {}), [METADATA_KEY]: dag }
  });
  return cell.getId();
}

/**
 * Delete a cell as the notebook panel would.
 *
 * @param model - The notebook model.
 * @param cellId - The cell to delete.
 * @returns False when there is no such cell or its metadata says `deletable: false`.
 *
 * @remarks
 * Mirrors `Private.deleteCells` (`@jupyterlab/notebook/src/actions.tsx:3278-3332`): the id is
 * pushed onto `INotebookModel.deletedCells` (`@jupyterlab/notebook/src/model.ts:63`), which the
 * next `runCell` sends to the kernel as `execute_request` metadata and then clears
 * (`@jupyterlab/notebook/src/cellexecutor.ts:80-93`); the deletion and, when the cell was the
 * last one, a replacement code cell are one undoable transaction. The cell's wires need no
 * cleanup: inbound ones are stored on the cell itself, outbound ones are ignored while their
 * source is missing and come back with an undo.
 */
export function deleteCell(model: INotebookModel, cellId: string): boolean {
  const shared = model.sharedModel;
  const index = shared.cells.findIndex(c => c.getId() === cellId);
  if (index < 0 || shared.cells[index].getMetadata('deletable') === false) {
    return false;
  }
  model.deletedCells.push(cellId);
  const wasLast = shared.cells.length === 1;
  shared.transact(() => {
    shared.deleteCell(index);
    if (wasLast) {
      shared.insertCell(0, { cell_type: 'code', metadata: { trusted: true } });
    }
  }, true);
  return true;
}

/**
 * Clear a code cell's outputs and execution count, as `NotebookActions.clearOutputs` does.
 *
 * @param cell - The code cell model.
 * @param widget - The cell's widget, if one is mounted; its collapsed output area is reopened.
 *
 * @remarks
 * `ICodeCellModel.clearExecution` (`@jupyterlab/cells/src/model.ts:706-714`) empties the outputs,
 * nulls the execution count and drops the `execution` metadata. The `collapsed` metadata goes too:
 * core reopens the output area through the widget's `outputHidden`, which a notebook cell syncs
 * into that metadata, while a DAG node's cell has no such sync. The transaction is not undoable,
 * matching core (`@jupyterlab/notebook/src/actions.tsx:1801-1807`).
 */
export function clearOutputs(cell: ICodeCellModel, widget?: CodeCell): void {
  cell.sharedModel.transact(() => {
    cell.clearExecution();
    cell.deleteMetadata('collapsed');
    if (widget) {
      widget.outputHidden = false;
    }
  }, false);
}
