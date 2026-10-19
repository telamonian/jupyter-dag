/**
 * A cache of the kernel's per-cell analysis, keyed by cell id and invalidated by source.
 *
 * Both executors need the same thing from `analyze_request`: for each code cell, the names its
 * current source defines and references, fetched in as few requests as possible. The cache keeps
 * each result together with the source it was computed from, so a refresh sends only the cells
 * whose source changed since, in one request.
 *
 * @module
 */
import { inferWires } from './wiring';
import type { ICellNames } from './wiring';
import type { IWire } from './tokens';
import type { DagKernelClient, IAnalyzeCellInput, IAnalyzedCell } from './protocol';

/** The part of a shared cell model the cache reads. */
export interface IAnalyzableSharedModel {
  /** The cell's current source. */
  getSource(): string;
}
/** The part of a cell model the cache reads; `ICellModel` satisfies it, and so does a test stub. */
export interface IAnalyzableCell {
  /** The cell id. */
  readonly id: string;
  /** `'code'`, `'markdown'` or `'raw'`; only code cells are analysed. */
  readonly type: string;
  /** The shared model, for the current source. */
  readonly sharedModel: IAnalyzableSharedModel;
}

/** A cell's analysis together with the source it was computed from, so a changed source is re-analysed. */
interface IAnalyzedSource {
  /** The source text that was analysed. */
  source: string;
  /** What the kernel said about it. */
  result: IAnalyzedCell;
}

/**
 * Per-cell analysis results, refreshed from the kernel when a cell's source changes.
 *
 * @remarks
 * Nothing here listens to the notebook: callers decide when to {@link CellAnalysisCache.refresh},
 * before a run or after a notebook-panel run, and pass the cell models to consider. A refresh
 * compares each code cell's `sharedModel.getSource()` with the source its result was computed
 * from and sends the rest in one `analyze_request` through {@link DagKernelClient.analyze}, which
 * answers with an empty list when the kernel offers no analysis; results are stored by the id the
 * kernel echoes back (`cell_id`, `IAnalyzedCell` in `protocol.ts`). Markdown and raw cells bind
 * nothing and are never sent.
 */
export class CellAnalysisCache {
  /**
   * @param client - The kernel client whose `analyze` answers the requests.
   */
  constructor(client: Pick<DagKernelClient, 'analyze'>) {
    this._client = client;
  }
  /**
   * The stored analysis of a cell, if any.
   *
   * @param cellId - The cell id.
   * @returns The result, which may be an error result for source that did not parse.
   */
  get(cellId: string): IAnalyzedCell | undefined {
    return this._analysis.get(cellId)?.result;
  }
  /**
   * Drop a cell's result, for a cell that is being deleted.
   *
   * @param cellId - The cell id.
   */
  delete(cellId: string): void {
    this._analysis.delete(cellId);
  }
  /** Drop every result, for a kernel change: the earlier results may come from another kernel. */
  clear(): void {
    this._analysis.clear();
  }
  /** Every stored result, keyed by cell id. */
  results(): Map<string, IAnalyzedCell> {
    return new Map(Array.from(this._analysis, ([id, { result }]) => [id, result]));
  }
  /**
   * Analyse the code cells among `cells` whose source changed since their stored result, in one request.
   *
   * @param cells - The cells to consider; markdown and raw cells and unchanged code cells are skipped.
   * @returns Resolves once the results are stored; nothing is sent when no cell changed.
   */
  async refresh(cells: Iterable<IAnalyzableCell>): Promise<void> {
    const inputs: IAnalyzeCellInput[] = [];
    for (const cell of cells) {
      if (cell.type !== 'code') {
        continue;
      }
      const source = cell.sharedModel.getSource();
      if (this._analysis.get(cell.id)?.source !== source) {
        inputs.push({ cell_id: cell.id, code: source });
      }
    }
    if (!inputs.length) {
      return;
    }
    for (const result of await this._client.analyze(inputs)) {
      const input = inputs.find(c => c.cell_id === result.cell_id);
      if (input) {
        this._analysis.set(result.cell_id, { source: input.code, result });
      }
    }
  }
  /**
   * The defined and referenced names of the given cells, in the given order, for `inferWires` (`wiring.ts`).
   *
   * @param cellIds - The cells, in document order.
   * @returns One entry per cell that has a result that is not an error; cells that did not parse,
   * and cells never analysed, are left out and so get no wires.
   */
  names(cellIds: Iterable<string>): ICellNames[] {
    const cells: ICellNames[] = [];
    for (const id of cellIds) {
      const analysed = this.get(id);
      if (analysed && analysed.status !== 'error') {
        cells.push({ id, defined: analysed.defined, referenced: analysed.referenced });
      }
    }
    return cells;
  }
  /**
   * The wires the stored analysis implies between the given cells.
   *
   * @param cellIds - The cells, in document order.
   * @returns `inferWires` (`wiring.ts`) over {@link CellAnalysisCache.names}.
   */
  wires(cellIds: Iterable<string>): IWire[] {
    return inferWires(this.names(cellIds));
  }
  private _client: Pick<DagKernelClient, 'analyze'>;
  private _analysis = new Map<string, IAnalyzedSource>();
}
