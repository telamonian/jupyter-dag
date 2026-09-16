import { graphlib, layout } from '@dagrejs/dagre';
import type { GraphLabel, NodeLabel } from '@dagrejs/dagre';
import { Position } from '@xyflow/react';
import type { Edge, Node, XYPosition } from '@xyflow/react';

export type LayoutDirection = 'TB' | 'LR';
export interface ILayoutOptions extends Pick<GraphLabel, 'nodesep' | 'ranksep' | 'edgesep'> {
  direction: LayoutDirection;
  fallbackWidth?: number;
  fallbackHeight?: number;
}
export const DEFAULT_LAYOUT: Required<ILayoutOptions> = {
  direction: 'TB',
  nodesep: 24,
  ranksep: 48,
  edgesep: 12,
  fallbackWidth: 360,
  fallbackHeight: 140
};

export function layoutElements<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
  partial: Partial<ILayoutOptions> = {}
): N[] {
  const options: Required<ILayoutOptions> = { ...DEFAULT_LAYOUT, ...partial };
  const g = new graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  const label: GraphLabel = {
    rankdir: options.direction,
    nodesep: options.nodesep,
    ranksep: options.ranksep,
    edgesep: options.edgesep
  };
  g.setGraph(label);
  const connected = new Set<string>(edges.flatMap(e => [e.source, e.target]));
  const sizeOf = (n: N) => ({
    width: n.measured?.width ?? n.width ?? options.fallbackWidth,
    height: n.measured?.height ?? n.height ?? options.fallbackHeight
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
  const isLR = options.direction === 'LR';
  const sourcePosition = isLR ? Position.Right : Position.Bottom;
  const targetPosition = isLR ? Position.Left : Position.Top;
  let sideY = 0;
  // dagre reports an empty graph's width as -Infinity (not null), so `??` is not enough here.
  const graphWidth = g.graph().width;
  const sideX = (Number.isFinite(graphWidth) ? (graphWidth as number) : 0) + (options.ranksep ?? 48);
  return nodes.map(n => {
    if (!connected.has(n.id)) {
      // disconnected: stack in a side column (marimo layout.ts precedent)
      const position: XYPosition = { x: sideX, y: sideY };
      sideY += sizeOf(n).height + (options.nodesep ?? 24);
      return { ...n, position, sourcePosition, targetPosition };
    }
    const nl: NodeLabel = g.node(n.id);
    const position: XYPosition = { x: (nl.x ?? 0) - (nl.width ?? 0) / 2, y: (nl.y ?? 0) - (nl.height ?? 0) / 2 }; // dagre returns centers
    return { ...n, position, sourcePosition, targetPosition };
  });
}
