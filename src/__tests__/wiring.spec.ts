/**
 * Unit tests for the pure graph algorithms in `dag/wiring.ts`.
 *
 * They run on plain wire lists without a notebook model. Not covered: `DagGraphModel`'s signal
 * fan-in and the metadata helpers, which need a shared model (a Lab-side test would cover them).
 */
import { downstreamOf, inferWires, topologicalOrder, upstreamOf, wouldCreateCycle } from '../dag/wiring';
import type { IWire } from '../dag/tokens';

const wires: IWire[] = [
  { id: 'a->b', source: 'a', target: 'b' },
  { id: 'b->c', source: 'b', target: 'c' }
];

describe('wiring', () => {
  it('orders cells topologically, breaking ties by document order', () => {
    expect(topologicalOrder(['c', 'b', 'a'], wires)).toEqual(['a', 'b', 'c']);
    expect(topologicalOrder(['x', 'a', 'b'], wires)).toEqual(['x', 'a', 'b']);
  });
  it('rejects wires that would close a cycle', () => {
    expect(wouldCreateCycle(wires, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(wires, 'a', 'c')).toBe(false);
    expect(wouldCreateCycle(wires, 'a', 'a')).toBe(true);
  });
  it('computes closures', () => {
    expect([...downstreamOf(['a'], wires, false)].sort()).toEqual(['b', 'c']);
    expect([...upstreamOf(['c'], wires, true)].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('inferWires', () => {
  it('wires each reader to the nearest definer above it', () => {
    const wires = inferWires([
      { id: 'a', defined: ['x'], referenced: [] },
      { id: 'b', defined: ['y'], referenced: ['x', 'print'] },
      { id: 'c', defined: [], referenced: ['x', 'y'] },
      { id: 'd', defined: ['x'], referenced: [] },
      { id: 'e', defined: [], referenced: ['x'] }
    ]);
    expect(wires.map(w => w.id)).toEqual(['a->b', 'a->c', 'b->c', 'd->e']);
  });
  it('wraps round to the last definer below a reader that has none above', () => {
    const wires = inferWires([
      { id: 'a', defined: [], referenced: ['w'] },
      { id: 'b', defined: ['w'], referenced: [] },
      { id: 'c', defined: ['w'], referenced: [] },
      { id: 'd', defined: ['x'], referenced: ['w'] }
    ]);
    expect(wires.map(w => w.id)).toEqual(['c->d', 'c->a']);
  });
  it('leaves out a wrapped wire that would close a cycle with the forward ones', () => {
    const wires = inferWires([
      { id: 'a', defined: ['x'], referenced: ['y'] },
      { id: 'b', defined: ['y'], referenced: ['x'] }
    ]);
    expect(wires.map(w => w.id)).toEqual(['a->b']);
  });
  it('makes one wire per pair even when several names are shared', () => {
    const wires = inferWires([
      { id: 'a', defined: ['x', 'y'], referenced: [] },
      { id: 'b', defined: [], referenced: ['y', 'x'] }
    ]);
    expect(wires).toEqual([{ id: 'a->b', source: 'a', target: 'b' }]);
  });
});
