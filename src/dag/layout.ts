/**
 * Automatic layout of the DAG canvas with dagre.
 *
 * dagre lays out a directed graph in ranks: sources at the top (or left), each edge pointing to a
 * later rank, nodes within a rank spread apart. Nodes without wires are stacked in a column beside
 * the graph, after marimo's precedent for cells that are not connected to anything.
 *
 * @see https://github.com/dagrejs/dagre/wiki for dagre's graph API and layout options.
 * @module
 */
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

/**
 * Compute a position for every node and return copies of the nodes with the positions applied.
 *
 * @typeParam N - The React Flow node type; the nodes come back with the same type.
 * @typeParam E - The React Flow edge type.
 * @param nodes - The nodes to place. Their `measured` size (set by React Flow once the node is
 * in the DOM), their persisted `width`/`height`, or a fallback size decides how much room each
 * takes.
 * @param edges - The wires; only their `source` and `target` are used.
 * @param direction - `'TB'` (top to bottom) or `'LR'` (left to right).
 * @returns New node objects with `position`, `sourcePosition` and `targetPosition` set; the input
 * array is not modified.
 *
 * @remarks
 * dagre writes each node's centre as `x` and `y` onto its label, while a React Flow node's
 * `position` is its top-left corner, hence the half-size subtraction; `nodesep`, `ranksep` and
 * `edgesep` are in pixels.
 *
 * With no nodes at all, `g.graph().width` after `layout` is `-Infinity` (the built package folds
 * the bounds over an empty list), so `Number.isFinite`, not `??`, decides whether there is a graph
 * to place the side column next to. A node with no wires is left out of the dagre graph on
 * purpose: dagre would otherwise give every isolated node its own rank and stretch the drawing.
 *
 * `sourcePosition` and `targetPosition` tell React Flow which side of a node an edge leaves from
 * and arrives at (`Position.Bottom` to `Position.Top` for a top-to-bottom layout); they have to
 * follow the direction or the bezier edges double back.
 *
 * @see https://reactflow.dev/api-reference/types/node for `measured`, `position` and the handle positions.
 */
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
