import { graphlib, layout } from '@dagrejs/dagre';
import type { NodeLabel } from '@dagrejs/dagre';
import { Position } from '@xyflow/react';
import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { LayoutDirection } from './tokens';

const NODESEP = 24;
const RANKSEP = 48;
const EDGESEP = 12;
/** Size assumed for nodes React Flow has not measured yet. */
const FALLBACK = { width: 360, height: 140 };

export function layoutElements<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
  direction: LayoutDirection = 'TB'
): N[] {
  const g = new graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: NODESEP, ranksep: RANKSEP, edgesep: EDGESEP });
  const connected = new Set<string>(edges.flatMap(e => [e.source, e.target]));
  const sizeOf = (n: N) => ({
    width: n.measured?.width ?? n.width ?? FALLBACK.width,
    height: n.measured?.height ?? n.height ?? FALLBACK.height
  });
  for (const n of nodes) {
    if (connected.has(n.id)) {
      g.setNode(n.id, sizeOf(n));
    }
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  layout(g);
  const isLR = direction === 'LR';
  const sourcePosition = isLR ? Position.Right : Position.Bottom;
  const targetPosition = isLR ? Position.Left : Position.Top;
  let sideY = 0;
  // dagre reports an empty graph's width as -Infinity (not null), so `??` is not enough here.
  const graphWidth = g.graph().width;
  const sideX = (Number.isFinite(graphWidth) ? (graphWidth as number) : 0) + RANKSEP;
  return nodes.map(n => {
    if (!connected.has(n.id)) {
      // disconnected: stack in a side column (marimo layout.ts precedent)
      const position: XYPosition = { x: sideX, y: sideY };
      sideY += sizeOf(n).height + NODESEP;
      return { ...n, position, sourcePosition, targetPosition };
    }
    const nl: NodeLabel = g.node(n.id);
    const position: XYPosition = { x: (nl.x ?? 0) - (nl.width ?? 0) / 2, y: (nl.y ?? 0) - (nl.height ?? 0) / 2 }; // dagre returns centers
    return { ...n, position, sourcePosition, targetPosition };
  });
}
