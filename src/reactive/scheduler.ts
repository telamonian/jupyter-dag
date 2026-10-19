/**
 * The order of a reactive notebook, with no notebook in sight.
 *
 * `ReactiveScheduler` decides what runs when: it takes the cells the user asked to run, pulls in
 * the never-run cells they depend on, re-runs the cells that depend on what just ran, and makes
 * sure nothing runs twice for one request. It knows cells only by id, gets the wires and the runs
 * from an {@link IReactiveHost}, and so can be exercised in a unit test with a fake host.
 *
 * @module
 */
import { downstreamOf, topologicalOrder, upstreamOf } from '../dag/wiring';
import type { IWire } from '../dag/tokens';

/**
 * What the scheduler needs from its surroundings: the graph, and a way to run one cell.
 *
 * @typeParam T - Whatever the caller passes along with a run request, handed back to {@link IReactiveHost.run}.
 */
export interface IReactiveHost<T> {
  /** The ids of the code cells, in document order. */
  codeCellIds(): string[];
  /**
   * Bring the analysis up to date with the cells' sources. Must not throw: a failed refresh leaves
   * the previous analysis in place and the run goes on with it.
   */
  refresh(): Promise<void>;
  /** The wires the current analysis implies. */
  wires(): IWire[];
  /**
   * Run one cell.
   *
   * @param cellId - The cell to run.
   * @param trigger - What came with the request this run is part of.
   * @returns True when the cell ran successfully, or no longer exists. A thrown error is
   * passed to whoever requested the run and ends the batch.
   */
  run(cellId: string, trigger: T): Promise<boolean>;
  /**
   * Unbind what a cell's last run bound; called before a cell that has already run runs again.
   *
   * @param cellId - The cell about to run.
   */
  purge(cellId: string): void;
}

/** One queued request. */
interface ITurn<T> {
  cellId: string;
  trigger: T;
  generation: number;
  resolve: (ran: boolean) => void;
  reject: (reason: unknown) => void;
}

/**
 * Serialises run requests for one notebook and adds the reactive rules around each.
 *
 * @typeParam T - The request payload type; see {@link IReactiveHost}.
 *
 * @remarks
 * Batches. The notebook queues every cell of a selection in one go, so requests that arrive
 * while the queue is busy are treated as one batch with the one being served: a cell runs at most
 * once per batch, and a failure ends the batch, with the requests still queued answered `false`
 * without running, which is what the kernel's `stop_on_error` does for the notebook's own queue.
 *
 * First runs. A cell that has not run since the kernel started pulls in, before itself, the cells
 * it depends on (transitively) that have not run either, in topological order. A cell run from
 * elsewhere counts once {@link ReactiveScheduler.markRan} says so.
 *
 * Re-runs. After a cell runs successfully, the cells downstream of it that have already run are
 * marked stale, except those still queued in the same batch, which will run in their turn. Once
 * the queue is empty the stale cells run in topological order, each marking its own downstream
 * stale, until none is left. A cell that has never run is not pulled in by staleness: running it
 * is the user's choice, and doing so pulls in whatever it needs.
 *
 * Purges. A cell that has run before is purged before it runs again, so a re-run never inherits
 * the names its previous source bound.
 *
 * Restarts. {@link ReactiveScheduler.reset} forgets every run and every stale mark and bumps a
 * generation counter; queued requests from before the reset are answered `false`.
 */
export class ReactiveScheduler<T> {
  /**
   * @param host - The graph and the runner.
   */
  constructor(host: IReactiveHost<T>) {
    this._host = host;
  }
  /** The cells that have run successfully since the last reset. */
  get ran(): ReadonlySet<string> {
    return this._ran;
  }
  /** The cells marked stale and not yet re-run; empty between batches. */
  get stale(): ReadonlySet<string> {
    return this._stale;
  }
  /** Whether a batch is being served. */
  get busy(): boolean {
    return this._draining;
  }
  /**
   * Queue a request to run a cell.
   *
   * @param cellId - The cell.
   * @param trigger - Passed to {@link IReactiveHost.run} for this cell and for the cells it pulls in.
   * @returns Resolves with the cell's own result once its turn, and its prerequisites, are done;
   * rejects with whatever the host's `run` threw.
   */
  enqueue(cellId: string, trigger: T): Promise<boolean> {
    this._pending.add(cellId);
    return new Promise<boolean>((resolve, reject) => {
      this._queue.push({ cellId, trigger, generation: this._generation, resolve, reject });
      if (!this._draining) {
        void this._drain();
      }
    });
  }
  /**
   * Record that a cell ran successfully outside this scheduler.
   *
   * @param cellId - The cell.
   */
  markRan(cellId: string): void {
    this._ran.add(cellId);
  }
  /** Forget every run and stale mark, and cancel the requests still queued: the namespace is gone. */
  reset(): void {
    this._generation += 1;
    this._ran.clear();
    this._stale.clear();
  }
  /** Serve the queue, then the stale cells, then close the batch. */
  private async _drain(): Promise<void> {
    this._draining = true;
    try {
      for (;;) {
        const turn = this._queue.shift();
        if (turn) {
          this._lastTrigger = turn.trigger;
          try {
            turn.resolve(await this._turn(turn));
          } catch (reason) {
            turn.reject(reason);
          }
          continue;
        }
        if (this._failed || this._lastTrigger === undefined) {
          break;
        }
        await this._host.refresh();
        const wires = this._host.wires();
        const next = topologicalOrder(this._host.codeCellIds(), wires).find(id => this._stale.has(id));
        if (next === undefined) {
          break;
        }
        try {
          await this._runOne(next, this._lastTrigger, wires);
        } catch {
          // the failure was reported through the run's own callbacks; the batch is over
        }
      }
    } finally {
      this._stale.clear();
      this._failed = false;
      this._ranInBatch.clear();
      this._pending.clear();
      this._lastTrigger = undefined;
      this._draining = false;
    }
  }
  /** Serve one request: prerequisites first, then the cell itself. */
  private async _turn(turn: ITurn<T>): Promise<boolean> {
    const { cellId, trigger } = turn;
    if (this._failed || turn.generation !== this._generation) {
      this._pending.delete(cellId);
      return false;
    }
    if (this._ranInBatch.has(cellId)) {
      this._pending.delete(cellId);
      return true;
    }
    await this._host.refresh();
    const wires = this._host.wires();
    if (!this._ran.has(cellId)) {
      const upstream = upstreamOf([cellId], wires, false);
      const prerequisites = topologicalOrder(this._host.codeCellIds(), wires).filter(
        id => upstream.has(id) && !this._ran.has(id) && !this._ranInBatch.has(id)
      );
      for (const id of prerequisites) {
        if (!(await this._runOne(id, trigger, wires))) {
          this._pending.delete(cellId);
          return false;
        }
      }
    }
    this._pending.delete(cellId);
    return this._runOne(cellId, trigger, wires);
  }
  /** Run one cell and update the records; a failure, thrown or returned, ends the batch. */
  private async _runOne(cellId: string, trigger: T, wires: IWire[]): Promise<boolean> {
    this._stale.delete(cellId);
    if (this._ran.has(cellId)) {
      this._host.purge(cellId);
    }
    let ran: boolean;
    try {
      ran = await this._host.run(cellId, trigger);
    } catch (reason) {
      this._fail();
      throw reason;
    }
    if (!ran) {
      this._fail();
      return false;
    }
    this._ran.add(cellId);
    this._ranInBatch.add(cellId);
    for (const id of downstreamOf([cellId], wires, false)) {
      if (this._ran.has(id) && !this._pending.has(id)) {
        this._stale.add(id);
      }
    }
    return true;
  }
  /** End the batch: nothing else runs, and nothing stays stale. */
  private _fail(): void {
    this._failed = true;
    this._stale.clear();
  }
  private _host: IReactiveHost<T>;
  private _queue: ITurn<T>[] = [];
  private _pending = new Set<string>();
  private _ranInBatch = new Set<string>();
  private _ran = new Set<string>();
  private _stale = new Set<string>();
  private _lastTrigger: T | undefined;
  private _failed = false;
  private _draining = false;
  private _generation = 0;
}
