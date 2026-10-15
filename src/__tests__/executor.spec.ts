/**
 * Unit tests for the pure helper of `dag/executor.ts`; the executor itself needs a kernel.
 */
import { namesToUnbind } from '../dag/executor';

describe('namesToUnbind', () => {
  it('returns what the cell bound, minus names another cell also bound', () => {
    const executed = new Map([
      ['a', ['x', 'shared']],
      ['b', ['shared', 'y']]
    ]);
    expect(namesToUnbind(executed, 'a')).toEqual(['x']);
    expect(namesToUnbind(executed, 'b')).toEqual(['y']);
  });
  it('returns nothing for a cell with no run on record', () => {
    expect(namesToUnbind(new Map([['a', ['x']]]), 'zzz')).toEqual([]);
  });
});
