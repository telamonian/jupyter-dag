/**
 * The React Flow edge for a wire: the built-in bezier edge plus a remove button while selected.
 *
 * An edge has no DOM box of its own to put a button in, so the button rides in React Flow's edge
 * toolbar, a portal into the edge-label layer that is anchored at a flow coordinate and scaled
 * back by `1/zoom`, so it keeps its screen size at every zoom level.
 *
 * @see https://reactflow.dev/api-reference/components/edge-toolbar
 * @module
 */
import React, { memo } from 'react';
import { BezierEdge, EdgeToolbar, useReactFlow } from '@xyflow/react';
import type { EdgeProps, EdgeTypes } from '@xyflow/react';
import { closeIcon } from '@jupyterlab/ui-components';
import { NodeButton, useCellNodeContext } from './cellnode';
import { edgeButtonAnchor } from './layout';

/**
 * The edge component: a bezier path and, while the edge is selected, an "x" near its upper end.
 *
 * @param props - React Flow's `EdgeProps`; `selected` gates the button and the endpoints place it.
 * @returns The edge element.
 *
 * @remarks
 * `BezierEdge` is what React Flow renders for a type-less edge, so the wire looks as before;
 * `markerEnd` arrives already resolved to a `url(#...)` reference. The button is anchored by
 * {@link edgeButtonAnchor} at the upper endpoint with `alignX="left"`; the padding on the toolbar
 * class then moves it 8px to the right and 3px away from the node, in screen pixels because the
 * box sits inside the `1/zoom` scale. The click goes through `deleteElements`, the same path as
 * Backspace, so the canvas's `onEdgesChange` removes the wire from the notebook. Selecting an edge
 * unselects every node, so the button never overlaps a node toolbar.
 *
 * @see https://reactflow.dev/api-reference/types/edge-props
 * @see https://reactflow.dev/api-reference/types/react-flow-instance#deleteelements
 */
function WireEdgeView(props: EdgeProps): JSX.Element {
  const { id, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const { markerEnd, markerStart, style, interactionWidth } = props;
  const ctx = useCellNodeContext();
  const instance = useReactFlow();
  const anchor = edgeButtonAnchor({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BezierEdge
        id={id}
        sourceX={sourceX}
        sourceY={sourceY}
        targetX={targetX}
        targetY={targetY}
        sourcePosition={sourcePosition}
        targetPosition={targetPosition}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
        interactionWidth={interactionWidth}
      />
      {selected ? (
        <EdgeToolbar
          edgeId={id}
          x={anchor.x}
          y={anchor.y}
          alignX="left"
          alignY={anchor.alignY}
          className={`jp-DagWire-toolbar jp-DagWire-toolbar-${anchor.alignY} nodrag nopan`}
        >
          <NodeButton
            small
            icon={closeIcon}
            title={ctx.trans.__('Remove edge')}
            onClick={() => void instance.deleteElements({ edges: [{ id }] })}
          />
        </EdgeToolbar>
      ) : null}
    </>
  );
}

/**
 * The edge types passed to React Flow: one, `wire`.
 *
 * @remarks
 * Module scope for the same reason as `nodeTypes` in `cellnode.tsx`: React Flow compares the
 * object by identity, and error 002 covers edge types too.
 *
 * @see https://reactflow.dev/error#002
 */
export const edgeTypes: EdgeTypes = { wire: memo(WireEdgeView) };
