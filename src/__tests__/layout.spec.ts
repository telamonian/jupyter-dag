/**
 * Unit tests for `dag/layout.ts` (the two dagre edge cases the layout code guards against) and
 * `readCellMetadata`.
 */
import { layoutElements } from '../dag/layout';
import { readCellMetadata } from '../dag/tokens';
import type { Edge, Node } from '@xyflow/react';

// dagre clones with structuredClone, which jsdom does not provide.
if (typeof globalThis.structuredClone === 'undefined') {
  (globalThis as { structuredClone?: unknown }).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const node = (id: string): Node => ({ id, position: { x: 0, y: 0 }, data: {} });

describe('layoutElements', () => {
  it('gives disconnected nodes finite positions even when the dagre graph is empty', () => {
    const laid = layoutElements([node('a'), node('b')], []);
    for (const n of laid) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    expect(laid[1].position.y).toBeGreaterThan(laid[0].position.y);
  });

  it('places a wired target below its source in top-to-bottom layout', () => {
    const edges: Edge[] = [{ id: 'a->b', source: 'a', target: 'b' }];
    const [a, b] = layoutElements([node('a'), node('b')], edges, 'TB');
    expect(b.position.y).toBeGreaterThan(a.position.y);
  });
});

describe('readCellMetadata', () => {
  it('drops non-finite positions and sizes', () => {
    const meta = readCellMetadata({ inputs: ['x'], position: { x: null, y: 0 }, width: null, height: 120 });
    expect(meta).toEqual({ inputs: ['x'], height: 120 });
  });
});
