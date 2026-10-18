/**
 * The `INotebookCellExecutor` the notebook panel runs cells through.
 *
 * Every `NotebookActions.run*` call ends in `executor.runCell(options)` on the token's object
 * (`@jupyterlab/notebook/src/actions.tsx:3018-3045`). This one looks the notebook's controller
 * up and lets it decide; a notebook without a controller, which is any notebook not shown in a
 * panel the registry knows, gets the core `runCell` unchanged.
 *
 * @module
 */
import { runCell } from '@jupyterlab/notebook';
import type { INotebookCellExecutor } from '@jupyterlab/notebook';
import type { ReactiveRegistry } from './controller';

/**
 * Build the executor the plugin provides for the token.
 *
 * @param registry - Where the controllers are.
 * @returns A frozen object, as core's provider makes
 * (`@jupyterlab/notebook-extension/src/cellexecutor.ts:17`).
 */
export function createReactiveCellExecutor(registry: ReactiveRegistry): INotebookCellExecutor {
  return Object.freeze({
    runCell: (options: INotebookCellExecutor.IRunCellOptions): Promise<boolean> =>
      registry.controllerFor(options.notebook)?.runCell(options) ?? runCell(options)
  });
}
