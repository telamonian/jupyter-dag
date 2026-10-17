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
import type { Dimensions, Edge, Node, Rect, Transform, XYPosition } from '@xyflow/react';
import type { LayoutDirection } from './tokens';

const NODESEP = 24;
/** The gap between ranks, in pixels; also the gap under a selected node where a new cell's node goes. */
export const RANKSEP = 48;
const EDGESEP = 12;
/** The size assumed for a node React Flow has not measured yet, and the size a new node is centred with. */
export const DEFAULT_NODE_SIZE: Dimensions = { width: 360, height: 140 };

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
 * A node with no wires is left out of the dagre graph: dagre would otherwise give every isolated
 * node its own rank and stretch the drawing. The dagre graph is therefore empty whenever the
 * notebook has no wires, and then `g.graph().width` after `layout` is `-Infinity` (the built
 * package folds the bounds over an empty list), which is why `Number.isFinite`, not `??`, decides
 * whether there is a graph to place the side column next to.
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
    width: n.measured?.width ?? n.width ?? DEFAULT_NODE_SIZE.width,
    height: n.measured?.height ?? n.height ?? DEFAULT_NODE_SIZE.height
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

/**
 * The top-left corner that centres a node of `size` in the visible part of the canvas.
 *
 * @param width - The canvas width in screen pixels.
 * @param height - The canvas height in screen pixels.
 * @param transform - The viewport as React Flow's store keeps it: `[x, y, zoom]`.
 * @param size - The node size to centre.
 * @returns The position in flow coordinates.
 *
 * @remarks
 * The screen-to-flow conversion is `(screen - pan) / zoom`, what React Flow's
 * `pointToRendererPoint` does for `screenToFlowPosition`; that helper takes client coordinates
 * and reads the DOM, whereas the store's `width`, `height` and `transform` are already at hand.
 *
 * @see https://reactflow.dev/api-reference/hooks/use-store
 */
export function viewportCentre(width: number, height: number, transform: Transform, size: Dimensions): XYPosition {
  const [tx, ty, zoom] = transform;
  return { x: (width / 2 - tx) / zoom - size.width / 2, y: (height / 2 - ty) / zoom - size.height / 2 };
}

/**
 * The position one rank below a rectangle, left-aligned with it.
 *
 * @param rect - The bounds of the selected nodes, in flow coordinates.
 * @param gap - The vertical gap; {@link RANKSEP} by default, so the node sits where auto-layout would put a new rank.
 * @returns The top-left corner for a node placed under `rect`.
 */
export function positionBelow(rect: Rect, gap = RANKSEP): XYPosition {
  return { x: rect.x, y: rect.y + rect.height + gap };
}

/** The two endpoints of an edge, as React Flow passes them to an edge component. */
export interface IEdgeEndpoints {
  /** Where the edge leaves the source node. */
  sourceX: number;
  /** Where the edge leaves the source node. */
  sourceY: number;
  /** Where the edge enters the target node. */
  targetX: number;
  /** Where the edge enters the target node. */
  targetY: number;
}

/** Where the remove button of a selected edge is anchored. */
export interface IEdgeButtonAnchor {
  /** The anchor's horizontal flow coordinate. */
  x: number;
  /** The anchor's vertical flow coordinate. */
  y: number;
  /** Which side of the anchor the button hangs on: below the top end of a downward edge, above it when the edge runs upward. */
  alignY: 'top' | 'bottom';
}

/**
 * The anchor for an edge's remove button: the endpoint with the smaller `y`.
 *
 * @param edge - The edge's endpoints.
 * @returns The upper endpoint and the side the button goes on.
 *
 * @remarks
 * Handles are fixed at the top (target) and bottom (source) of every node, so in a top-to-bottom
 * layout the upper end is the source and the button hangs below it, clear of the node. In a
 * left-to-right layout an edge can run upward; its upper end is then the arrowhead on the target,
 * and the button goes above it instead of over the target node.
 */
export function edgeButtonAnchor(edge: IEdgeEndpoints): IEdgeButtonAnchor {
  return edge.sourceY <= edge.targetY
    ? { x: edge.sourceX, y: edge.sourceY, alignY: 'top' }
    : { x: edge.targetX, y: edge.targetY, alignY: 'bottom' };
}
