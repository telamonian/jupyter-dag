/**
 * Unit tests for the pure graph algorithms in `dag/wiring.ts`.
 *
 * They run on plain wire lists without a notebook model. Not covered: `DagGraphModel`'s signal
 * fan-in and the metadata helpers, which need a shared model (a Lab-side test would cover them).
 */
import { downstreamOf, topologicalOrder, upstreamOf, wouldCreateCycle } from '../dag/wiring';
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
