/**
 * Unit tests for `dag/layout.ts` (the two dagre edge cases the layout code guards against) and
 * `readCellMetadata`.
 */
import { RANKSEP, edgeButtonAnchor, layoutElements, positionBelow, viewportCentre } from '../dag/layout';
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

describe('viewportCentre', () => {
  it('converts the screen centre to flow coordinates and centres the node on it', () => {
    expect(viewportCentre(800, 600, [100, 50, 2], { width: 360, height: 140 })).toEqual({
      x: (400 - 100) / 2 - 180,
      y: (300 - 50) / 2 - 70
    });
  });
});

describe('positionBelow', () => {
  it('places a node one rank under a rectangle, left-aligned with it', () => {
    expect(positionBelow({ x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 10, y: 70 + RANKSEP });
  });
});

describe('edgeButtonAnchor', () => {
  it('anchors at the source end of a downward edge', () => {
    expect(edgeButtonAnchor({ sourceX: 0, sourceY: 10, targetX: 50, targetY: 100 })).toEqual({
      x: 0,
      y: 10,
      alignY: 'top'
    });
  });
  it('anchors at the target end of an upward edge', () => {
    expect(edgeButtonAnchor({ sourceX: 0, sourceY: 10, targetX: 50, targetY: 5 })).toEqual({
      x: 50,
      y: 5,
      alignY: 'bottom'
    });
  });
});
