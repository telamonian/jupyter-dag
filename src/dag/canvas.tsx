/**
 * The React Flow canvas: nodes and edges derived from the graph model, and the gestures that
 * write back to the notebook.
 *
 * React Flow is used in controlled mode: this component owns the `nodes` and `edges` arrays,
 * hands them to `ReactFlow`, and applies the change lists React Flow reports back
 * (`onNodesChange`, `onEdgesChange`). Anything that is document state (wires, positions, sizes,
 * the viewport) is written to the notebook model, and the canvas learns about it again through
 * the graph model's `changed` signal, so a wire added here and a wire added by another client
 * look the same to the canvas.
 *
 * @see https://reactflow.dev/learn/concepts/core-concepts for controlled flows.
 * @see https://reactflow.dev/api-reference/react-flow for the props used below.
 * @module
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  ControlButton,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useOnSelectionChange,
  useReactFlow,
  useStore
} from '@xyflow/react';
import type {
  Connection,
  DefaultEdgeOptions,
  Edge,
  EdgeChange,
  FitViewOptions,
  IsValidConnection,
  NodeChange,
  OnConnect,
  OnConnectEnd,
  OnEdgesChange,
  OnNodesChange,
  OnSelectionChangeFunc,
  Viewport
} from '@xyflow/react';
import type { ICellModel } from '@jupyterlab/cells';
import type { ISignal } from '@lumino/signaling';
import { CellNodeContext, nodeTypes, useLuminoSignal } from './cellnode';
import type { CellNode, ICellNodeContext } from './cellnode';
import { layoutElements } from './layout';
import {
  addWire,
  getCellMetadata,
  getNotebookMetadata,
  removeWire,
  updateCellMetadata,
  updateNotebookMetadata,
  wouldCreateCycle
} from './wiring';
import type { DagGraphModel } from './wiring';
import type { IDagCellMetadata, IDagGraphChange, IDagSettings, IWire, LayoutDirection } from './tokens';

// React Flow's default edge is the bezier we want; the class styles it (style/base.css).
const defaultEdgeOptions: DefaultEdgeOptions = { className: 'jp-DagWire', markerEnd: { type: MarkerType.ArrowClosed } };
const fitViewOptions: FitViewOptions<CellNode> = { padding: 0.2 };

/**
 * The React Flow edge for a wire: the built-in bezier edge, identified by the wire id.
 *
 * @param wire - The wire.
 * @returns An edge with no `type`, so React Flow renders its default edge with
 * `defaultEdgeOptions` (the `jp-DagWire` class and an arrow head) merged in.
 */
function wireToEdge(wire: IWire): Edge {
  return { id: wire.id, source: wire.source, target: wire.target };
}
/**
 * The React Flow node for a cell, positioned from its metadata or, failing that, stacked by index.
 *
 * @param cell - The cell model.
 * @param index - The cell's position in the notebook, for the fallback position.
 * @returns A `cellNode` with no data; the node reads everything from the graph model.
 *
 * @remarks
 * `deletable: false` is what stops React Flow from deleting nodes on Backspace: cells are deleted
 * in the notebook, never from the canvas, and the cell list drives `'nodes'` changes. React Flow's
 * `getElementsToRemove` skips non-deletable nodes and therefore also their connected edges, so
 * only explicitly selected edges are ever deleted from here.
 *
 * @see https://reactflow.dev/api-reference/types/node
 */
function cellToNode(cell: ICellModel, index: number): CellNode {
  const meta = getCellMetadata(cell);
  return {
    id: cell.id,
    type: 'cellNode',
    position: meta.position ?? { x: 0, y: index * 160 },
    width: meta.width,
    height: meta.height,
    deletable: false,
    data: {}
  };
}

/** Props of {@link DagCanvas}. */
export interface IDagCanvasProps {
  /** The graph model to display and edit. */
  graph: DagGraphModel;
  /** What the nodes need from the panel; provided to them through `CellNodeContext`. */
  nodeContext: ICellNodeContext;
  /** The view's settings: layout direction default and zoom limit. */
  settings: IDagSettings;
  /** Emitted by the document (toolbar / command) to run auto-layout. */
  layoutRequested: ISignal<unknown, void>;
}

/**
 * The flow itself; must live inside a `ReactFlowProvider` because it uses the React Flow hooks.
 *
 * @param props - See {@link IDagCanvasProps}.
 * @returns The `ReactFlow` element with its background and controls.
 *
 * @remarks
 * State kept here. `nodes` and `edges` are React state seeded from the model; `direction` is the
 * layout direction (from the notebook's metadata, else the settings); `defaultViewport` is read
 * once because React Flow only applies that prop at mount. `useNodesInitialized` reports when
 * every node has been measured in the DOM, and `useStore` exposes the container size; both gate
 * the first automatic layout, because `fitView` on a container of zero size (a tab that is not
 * yet shown) produces `NaN` positions.
 *
 * How model changes reach the canvas. `refresh` runs on every graph change. For `'nodes'` it
 * rebuilds the node array from the cell list but keeps the existing node object for every cell
 * that already had one, so React Flow keeps positions, measurements and selection and does not
 * remount the Lumino widget inside; for `'edges'` it does the same for edges; for `'state'` it
 * does nothing, because each node reads its own state (see `useNodeState` in `cellnode.tsx`).
 *
 * How gestures reach the model. A finished drag or resize is a `'position'` change with
 * `dragging: false` or a `'dimensions'` change with `resizing: false`; those are persisted to cell
 * metadata, batched in one `sharedModel.transact` (`@jupyter/ydoc/src/ydocument.ts:231-233`,
 * where the `undoable` flag makes the transaction one undo step). Connecting two ports calls
 * {@link addWire}; deleting a selected edge or reconnecting one calls {@link removeWire}; the model
 * then announces the change and `refresh` rebuilds the edges. Only `applyEdgeChanges` is still
 * applied locally, for selection changes. Auto-layout reads the current nodes and edges from the
 * React Flow instance (`getNodes`, `getEdges`) rather than from React state, so the callback does
 * not have to change identity every time a node moves.
 *
 * Why `isValidConnection` matters for performance. React Flow calls it on every pointer move while
 * a connection is being dragged, and it runs a cycle check over the wires, which is why
 * {@link DagGraphModel.wires} is cached. `ConnectionMode.Strict` means a connection must go from a
 * source handle to a target handle, so wires cannot be drawn backwards.
 *
 * On reconnect, the old wire is removed before the new one is added: `removeWire` writes the
 * metadata synchronously, which invalidates the wire cache, so the cycle check inside `addWire`
 * sees the graph without the old wire.
 *
 * @see https://reactflow.dev/api-reference/hooks/use-react-flow
 * @see https://reactflow.dev/api-reference/hooks/use-nodes-initialized
 * @see https://reactflow.dev/api-reference/types/node-change
 */
function DagFlow({ graph, settings, layoutRequested }: IDagCanvasProps): JSX.Element {
  const model = graph.notebook;
  const [nodes, setNodes] = useState<CellNode[]>(() => Array.from(model.cells, cellToNode));
  const [edges, setEdges] = useState<Edge[]>(() => graph.wires.map(wireToEdge));
  const [direction, setDirection] = useState<LayoutDirection>(
    () => getNotebookMetadata(model).direction ?? settings.layoutDirection
  );
  const [defaultViewport] = useState(() => getNotebookMetadata(model).viewport);
  const initialized = useNodesInitialized();
  const hasSize = useStore(s => s.width > 0 && s.height > 0);
  const instance = useReactFlow<CellNode, Edge>();

  const refresh = useCallback(
    (_: unknown, change: IDagGraphChange) => {
      if (change.type === 'state') {
        return;
      }
      if (change.type === 'nodes') {
        setNodes(current => {
          const previous = new Map(current.map(n => [n.id, n]));
          return Array.from(model.cells, (cell, i) => previous.get(cell.id) ?? cellToNode(cell, i));
        });
      }
      setEdges(current => {
        const previous = new Map(current.map(e => [e.id, e]));
        return graph.wires.map(w => previous.get(w.id) ?? wireToEdge(w));
      });
    },
    [graph, model]
  );
  useLuminoSignal(graph.changed, refresh);

  const persist = useCallback(
    (cellId: string, patch: Partial<IDagCellMetadata>) => {
      const cell = graph.findCell(cellId);
      if (cell) {
        updateCellMetadata(cell, patch);
      }
    },
    [graph]
  );
  const onLayout = useCallback(
    (dir: LayoutDirection) => {
      setDirection(dir);
      const laid = layoutElements(instance.getNodes(), instance.getEdges(), dir);
      setNodes(laid);
      model.sharedModel.transact(() => {
        updateNotebookMetadata(model, { direction: dir });
        for (const n of laid) {
          persist(n.id, { position: n.position });
        }
      }, true);
      if (hasSize) {
        void instance.fitView(fitViewOptions);
      }
    },
    [hasSize, instance, model, persist]
  );
  useEffect(() => {
    if (initialized && hasSize && !getNotebookMetadata(model).viewport) {
      onLayout(direction);
    }
  }, [initialized, hasSize]);
  const onLayoutRequested = useCallback(() => onLayout(direction), [onLayout, direction]);
  useLuminoSignal(layoutRequested, onLayoutRequested);

  const onNodesChange: OnNodesChange<CellNode> = useCallback(
    (changes: NodeChange<CellNode>[]) => {
      setNodes(current => applyNodeChanges(changes, current));
      const patches: [string, Partial<IDagCellMetadata>][] = [];
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          patches.push([change.id, { position: change.position }]);
        } else if (change.type === 'dimensions' && change.dimensions && change.resizing === false) {
          patches.push([change.id, { width: change.dimensions.width, height: change.dimensions.height }]);
        }
      }
      if (patches.length) {
        model.sharedModel.transact(() => patches.forEach(([id, patch]) => persist(id, patch)), true);
      }
    },
    [model, persist]
  );
  const onEdgesChange: OnEdgesChange<Edge> = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges(current => applyEdgeChanges(changes, current));
      for (const change of changes) {
        const edge = change.type === 'remove' ? instance.getEdge(change.id) : undefined;
        if (edge) {
          removeWire(graph, edge.source, edge.target);
        }
      }
    },
    [graph, instance]
  );
  const isValidConnection: IsValidConnection<Edge> = useCallback(
    (c: Edge | Connection) => !!c.source && !!c.target && !wouldCreateCycle(graph.wires, c.source, c.target),
    [graph]
  );
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      addWire(graph, connection.source, connection.target);
    },
    [graph]
  );
  const onReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      removeWire(graph, oldEdge.source, oldEdge.target);
      addWire(graph, connection.source, connection.target);
    },
    [graph]
  );
  const onConnectEnd: OnConnectEnd = useCallback((_event, state) => {
    if (!state.toNode) {
      // TODO: a wire dropped on empty canvas should insert a new cell there and wire it
      // (model.sharedModel.insertCell + addWire): the litegraph "drag out a node" gesture.
    }
  }, []);
  const onSelectionChange: OnSelectionChangeFunc<CellNode, Edge> = useCallback(({ nodes: selected }) => {
    // TODO: mirror the selection to the notebook panel's activeCell (and back) so both views agree.
    void selected;
  }, []);
  useOnSelectionChange({ onChange: onSelectionChange });
  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => updateNotebookMetadata(model, { viewport }),
    [model]
  );
  return (
    <ReactFlow<CellNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onReconnect={onReconnect}
      onMoveEnd={onMoveEnd}
      isValidConnection={isValidConnection}
      connectionMode={ConnectionMode.Strict}
      connectionLineType={ConnectionLineType.Bezier}
      defaultEdgeOptions={defaultEdgeOptions}
      defaultViewport={defaultViewport}
      minZoom={0.4}
      maxZoom={settings.maxZoom}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <Controls>
        <ControlButton title="Toggle layout direction" onClick={() => onLayout(direction === 'TB' ? 'LR' : 'TB')}>
          {direction}
        </ControlButton>
      </Controls>
    </ReactFlow>
  );
}

/**
 * The canvas component the DAG panel renders: the node context and React Flow provider around the flow component.
 *
 * @param props - See {@link IDagCanvasProps}.
 * @returns The canvas element.
 *
 * @remarks
 * `ReactFlowProvider` holds the React Flow store; the hooks `DagFlow` uses (`useReactFlow`,
 * `useStore`, `useNodesInitialized`, `useOnSelectionChange`) need to be rendered inside it, which
 * is why the flow is a separate component.
 *
 * @see https://reactflow.dev/api-reference/react-flow-provider
 */
export function DagCanvas(props: IDagCanvasProps): JSX.Element {
  return (
    <CellNodeContext.Provider value={props.nodeContext}>
      <ReactFlowProvider>
        <DagFlow {...props} />
      </ReactFlowProvider>
    </CellNodeContext.Provider>
  );
}
