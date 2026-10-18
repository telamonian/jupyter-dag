/**
 * Unit tests for `reactive/scheduler.ts` against a fake host.
 *
 * The host records every run in order, answers each one by hand, and derives its wires from a
 * fixed name table through the real `inferWires`, so the tests exercise the scheduling rules
 * (first runs, batches, re-runs, failures, resets) without a notebook or a kernel.
 */
import { ReactiveScheduler } from '../reactive/scheduler';
import type { IReactiveHost } from '../reactive/scheduler';
import { inferWires } from '../dag/wiring';
import type { ICellNames } from '../dag/wiring';
import type { IWire } from '../dag/tokens';

/** A run the fake host is holding until the test answers it. */
interface IPendingRun {
  id: string;
  trigger: string;
  resolve: (ran: boolean) => void;
  reject: (reason: unknown) => void;
}

/** A host whose runs resolve on demand, so a test can interleave requests with completions. */
class FakeHost implements IReactiveHost<string> {
  constructor(public cells: ICellNames[]) {}
  readonly runs: string[] = [];
  readonly purged: string[] = [];
  readonly queue: IPendingRun[] = [];
  refreshes = 0;
  codeCellIds(): string[] {
    return this.cells.map(c => c.id);
  }
  async refresh(): Promise<void> {
    this.refreshes += 1;
  }
  wires(): IWire[] {
    return inferWires(this.cells);
  }
  run(id: string, trigger: string): Promise<boolean> {
    this.runs.push(id);
    return new Promise((resolve, reject) => this.queue.push({ id, trigger, resolve, reject }));
  }
  purge(id: string): void {
    this.purged.push(id);
  }
  /** Answer the oldest held run. */
  async finish(ran = true): Promise<void> {
    const run = this.queue.shift();
    if (!run) {
      throw new Error('no run to finish');
    }
    run.resolve(ran);
    await flush();
  }
  /** Fail the oldest held run with a thrown error, as `runCell` does for a kernel error. */
  async throwNext(): Promise<void> {
    const run = this.queue.shift();
    if (!run) {
      throw new Error('no run to fail');
    }
    run.reject(new Error('KernelReplyNotOK'));
    await flush();
  }
  /** Answer every held run, and any run that completing one queues, until the host is idle. */
  async finishAll(): Promise<void> {
    while (this.queue.length) {
      await this.finish();
    }
  }
}

/** Let the scheduler's promise chain advance as far as it can. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** `a = 4`, `b = a*3`, `c = b**2` in that document order. */
const chain: ICellNames[] = [
  { id: 'a', defined: ['x'], referenced: [] },
  { id: 'b', defined: ['y'], referenced: ['x'] },
  { id: 'c', defined: ['z'], referenced: ['y'] }
];
/** A diamond: `d` reads what both `b` and `c` define, which both read `a`. */
const diamond: ICellNames[] = [
  { id: 'a', defined: ['x'], referenced: [] },
  { id: 'b', defined: ['y'], referenced: ['x'] },
  { id: 'c', defined: ['z'], referenced: ['x'] },
  { id: 'd', defined: [], referenced: ['y', 'z'] }
];

describe('ReactiveScheduler', () => {
  it('runs the never-run upstream of a never-run cell first', async () => {
    const host = new FakeHost(chain);
    const scheduler = new ReactiveScheduler(host);
    const result = scheduler.enqueue('c', 'run c');
    await flush();
    expect(host.runs).toEqual(['a']);
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b', 'c']);
    expect(host.purged).toEqual([]);
    await expect(result).resolves.toBe(true);
    expect([...scheduler.ran]).toEqual(['a', 'b', 'c']);
    expect(scheduler.busy).toBe(false);
  });
  it('runs each cell of an out-of-order run-all once', async () => {
    const host = new FakeHost(chain);
    const scheduler = new ReactiveScheduler(host);
    const results = ['c', 'b', 'a'].map(id => scheduler.enqueue(id, 'run all'));
    await flush();
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b', 'c']);
    await expect(Promise.all(results)).resolves.toEqual([true, true, true]);
    expect(host.purged).toEqual([]);
  });
  it('re-runs the dependents that have run, in order, after a single cell runs', async () => {
    const host = new FakeHost(diamond);
    const scheduler = new ReactiveScheduler(host);
    ['a', 'b', 'c', 'd'].forEach(id => scheduler.markRan(id));
    const result = scheduler.enqueue('a', 'run a');
    await flush();
    expect(host.runs).toEqual(['a']);
    expect(host.purged).toEqual(['a']);
    await host.finish();
    await expect(result).resolves.toBe(true); // the request resolves before the dependents settle
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b', 'c', 'd']);
    expect(host.purged).toEqual(['a', 'b', 'c', 'd']);
    expect(scheduler.stale.size).toBe(0);
  });
  it('leaves never-run dependents alone and honours runs recorded from outside', async () => {
    const host = new FakeHost(chain);
    const scheduler = new ReactiveScheduler(host);
    scheduler.markRan('a');
    scheduler.markRan('b');
    const result = scheduler.enqueue('a', 'run a');
    await flush();
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b']); // c never ran, so it is not pulled in
    await expect(result).resolves.toBe(true);
    const second = scheduler.enqueue('c', 'run c');
    await flush();
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b', 'c']); // a and b count as run, so c runs alone
    await expect(second).resolves.toBe(true);
  });
  it('stops the batch at a failed prerequisite and answers the rest false', async () => {
    const host = new FakeHost(chain);
    const scheduler = new ReactiveScheduler(host);
    const first = scheduler.enqueue('c', 'run c');
    const second = scheduler.enqueue('a', 'run c');
    first.catch(() => undefined);
    await flush();
    await host.finish(); // a
    await host.throwNext(); // b fails
    await expect(first).rejects.toThrow('KernelReplyNotOK');
    await expect(second).resolves.toBe(false);
    expect(host.runs).toEqual(['a', 'b']);
    expect(scheduler.stale.size).toBe(0);
    expect(scheduler.busy).toBe(false);
    // the next batch starts clean: c pulls in b again, since b never succeeded
    const third = scheduler.enqueue('c', 'run c again');
    await flush();
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b', 'b', 'c']);
    await expect(third).resolves.toBe(true);
  });
  it('treats a returned false like a failure', async () => {
    const host = new FakeHost(chain);
    const scheduler = new ReactiveScheduler(host);
    const result = scheduler.enqueue('b', 'run b');
    await flush();
    await host.finish(false); // a did not run
    await expect(result).resolves.toBe(false);
    expect(host.runs).toEqual(['a']);
    expect(scheduler.ran.size).toBe(0);
  });
  it('answers requests queued before a reset with false', async () => {
    const host = new FakeHost(chain);
    const scheduler = new ReactiveScheduler(host);
    ['a', 'b', 'c'].forEach(id => scheduler.markRan(id));
    const first = scheduler.enqueue('a', 'run a');
    const second = scheduler.enqueue('b', 'run b');
    await flush();
    scheduler.reset();
    await host.finish(); // a's run, started before the reset
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(host.runs).toEqual(['a']);
    expect(scheduler.ran.size).toBe(1); // a's own completion, on whatever kernel it ran
    expect(scheduler.stale.size).toBe(0);
  });
  it('serves a request that arrives during a settle before the remaining stale cells, once', async () => {
    const host = new FakeHost(diamond);
    const scheduler = new ReactiveScheduler(host);
    ['a', 'b', 'c', 'd'].forEach(id => scheduler.markRan(id));
    const first = scheduler.enqueue('a', 'run a');
    await flush();
    await host.finish(); // a; b, c and d are stale, b starts
    expect(host.runs).toEqual(['a', 'b']);
    const second = scheduler.enqueue('d', 'run d');
    await host.finish(); // b; d is queued, so it is served next
    expect(host.runs).toEqual(['a', 'b', 'd']);
    await host.finishAll();
    expect(host.runs).toEqual(['a', 'b', 'd', 'c', 'd']); // c was still stale, and re-running it makes d stale again
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
