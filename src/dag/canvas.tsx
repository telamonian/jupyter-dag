import React, { useCallback, useEffect, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionLineType,
  ConnectionMode,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  reconnectEdge,
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
  EdgeProps,
  EdgeTypes,
  FitViewOptions,
  IsValidConnection,
  NodeChange,
  OnBeforeDelete,
  OnConnect,
  OnConnectEnd,
  OnEdgesChange,
  OnNodesChange,
  OnSelectionChangeFunc,
  ReactFlowInstance,
  Viewport
} from '@xyflow/react';
import type { ISignal } from '@lumino/signaling';
import { CellNodeContext, nodeTypes } from './cellnode';
import type { CellNode, CellNodeData, ICellNodeContext } from './cellnode';
import { layoutElements } from './layout';
import type { LayoutDirection } from './layout';
import {
  addWire,
  getCellMetadata,
  getNotebookMetadata,
  removeWire,
  setCellMetadata,
  setNotebookMetadata,
  wouldCreateCycle
} from './wiring';
import type { DagGraphModel } from './wiring';
import type { IDagGraphChange, IDagSettings, IWire } from './tokens';

/** `names` is where analyze results (the variables carried by a wire) will be shown. */
export type DagEdgeData = { names?: string[] };
export type DagEdge = Edge<DagEdgeData, 'dagWire'>;

function DagWireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data
}: EdgeProps<DagEdge>): JSX.Element {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={selected ? 'jp-DagWire jp-mod-selected' : 'jp-DagWire'}
      />
      {data?.names?.length ? (
        <EdgeLabelRenderer>
          <div
            className="jp-DagWire-label nodrag nopan"
            style={{ position: 'absolute', transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          >
            {data.names.join(', ')}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
export const edgeTypes: EdgeTypes = { dagWire: DagWireEdge };
const defaultEdgeOptions: DefaultEdgeOptions = { type: 'dagWire', markerEnd: { type: MarkerType.ArrowClosed } };
const fitViewOptions: FitViewOptions<CellNode> = { padding: 0.2 };

export function wireToEdge(wire: IWire): DagEdge {
  return { id: wire.id, source: wire.source, target: wire.target, type: 'dagWire', data: {} };
}
export function buildNodes(graph: DagGraphModel, outputOnly: boolean): CellNode[] {
  return Array.from(graph.notebook.cells, (cell, index) => {
    const meta = getCellMetadata(cell);
    const data: CellNodeData = {
      cellId: cell.id,
      cellType: cell.type,
      executionCount: null,
      state: graph.stateOf(cell.id),
      outputOnly
    };
    return {
      id: cell.id,
      type: 'cellNode',
      position: meta.position ?? { x: 0, y: index * 160 },
      width: meta.width,
      height: meta.height,
      data
    };
  });
}
export function buildEdges(graph: DagGraphModel): DagEdge[] {
  return graph.wires.map(wireToEdge);
}

export interface IDagCanvasProps {
  graph: DagGraphModel;
  nodeContext: ICellNodeContext;
  settings: IDagSettings;
  /** Emitted by the document (toolbar / command) to run auto-layout. */
  layoutRequested: ISignal<unknown, void>;
  onInit: (instance: ReactFlowInstance<CellNode, DagEdge>) => void;
}

function DagFlow({ graph, settings, layoutRequested, onInit }: IDagCanvasProps): JSX.Element {
  const model = graph.notebook;
  const outputOnly = settings.outputOnlyNodes;
  const [nodes, setNodes] = useState<CellNode[]>(() => buildNodes(graph, outputOnly));
  const [edges, setEdges] = useState<DagEdge[]>(() => buildEdges(graph));
  const [direction, setDirection] = useState<LayoutDirection>(
    () => getNotebookMetadata(model).direction ?? settings.layoutDirection
  );
  const [defaultViewport] = useState(() => getNotebookMetadata(model).viewport); // React Flow reads it at mount only
  const initialized = useNodesInitialized();
  const hasSize = useStore(s => s.width > 0 && s.height > 0);
  const instance = useReactFlow<CellNode, DagEdge>();

  useEffect(() => {
    const refresh = (_: unknown, change: IDagGraphChange) => {
      switch (change.type) {
        case 'state': {
          // Patch in place so React Flow keeps node identities, positions and measurements.
          const ids = new Set(change.cellIds ?? []);
          setNodes(current =>
            current.map(n => (ids.has(n.id) ? { ...n, data: { ...n.data, state: graph.stateOf(n.id) } } : n))
          );
          break;
        }
        case 'edges':
          setEdges(buildEdges(graph));
          break;
        case 'nodes': {
          setNodes(current => {
            const previous = new Map(current.map(n => [n.id, n]));
            return buildNodes(graph, outputOnly).map(n => {
              const p = previous.get(n.id);
              return p ? { ...p, data: n.data } : n;
            });
          });
          setEdges(buildEdges(graph));
          break;
        }
        case 'layout':
          break;
      }
    };
    graph.changed.connect(refresh);
    return () => {
      graph.changed.disconnect(refresh);
    };
  }, [graph, outputOnly]);

  const onLayout = useCallback(
    (dir: LayoutDirection) => {
      setDirection(dir);
      const laid = layoutElements(nodes, edges, { direction: dir });
      setNodes(laid);
      // Persist the computed positions (drag-end is the only other writer), as one undoable transaction.
      model.sharedModel.transact(() => {
        setNotebookMetadata(model, { ...getNotebookMetadata(model), direction: dir });
        for (const n of laid) {
          const cell = graph.findCell(n.id);
          if (cell) {
            setCellMetadata(cell, { ...getCellMetadata(cell), position: n.position });
          }
        }
      }, true);
      if (hasSize) {
        void instance.fitView(fitViewOptions);
      }
    },
    [nodes, edges, graph, hasSize, instance, model]
  );
  useEffect(() => {
    if (initialized && hasSize && !getNotebookMetadata(model).viewport) {
      onLayout(direction);
    }
  }, [initialized, hasSize]);
  useEffect(() => {
    const handler = () => onLayout(direction);
    layoutRequested.connect(handler);
    return () => {
      layoutRequested.disconnect(handler);
    };
  }, [layoutRequested, onLayout, direction]);

  const onNodesChange: OnNodesChange<CellNode> = useCallback(
    (changes: NodeChange<CellNode>[]) => {
      // Nodes are never removed from the canvas directly; the cell list drives that through 'nodes' events.
      setNodes(current =>
        applyNodeChanges(
          changes.filter(c => c.type !== 'remove'),
          current
        )
      );
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          const cell = graph.findCell(change.id);
          if (cell) {
            setCellMetadata(cell, { ...getCellMetadata(cell), position: change.position });
          }
        }
        if (change.type === 'dimensions' && change.dimensions && change.resizing === false) {
          const cell = graph.findCell(change.id);
          if (cell) {
            setCellMetadata(cell, {
              ...getCellMetadata(cell),
              width: change.dimensions.width,
              height: change.dimensions.height
            });
          }
        }
      }
    },
    [graph]
  );
  const onEdgesChange: OnEdgesChange<DagEdge> = useCallback(
    (changes: EdgeChange<DagEdge>[]) => {
      setEdges(current => applyEdgeChanges(changes, current));
      for (const change of changes) {
        if (change.type === 'remove') {
          const edge = edges.find(e => e.id === change.id);
          if (edge) {
            removeWire(model, edge.source, edge.target);
          }
        }
      }
    },
    [edges, model]
  );
  const isValidConnection: IsValidConnection<DagEdge> = useCallback(
    (c: DagEdge | Connection) => !!c.source && !!c.target && !wouldCreateCycle(graph.wires, c.source, c.target),
    [graph]
  );
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const wire = addWire(model, connection.source, connection.target);
      if (wire) {
        setEdges(current => addEdge(wireToEdge(wire), current));
      }
    },
    [model]
  );
  const onReconnect = useCallback(
    (oldEdge: DagEdge, connection: Connection) => {
      removeWire(model, oldEdge.source, oldEdge.target);
      const wire = addWire(model, connection.source, connection.target);
      if (wire) {
        setEdges(current => reconnectEdge(oldEdge, connection, current));
      }
    },
    [model]
  );
  const onConnectEnd: OnConnectEnd = useCallback((_event, state) => {
    if (!state.toNode) {
      // TODO: a wire dropped on empty canvas should insert a new cell there and wire it
      // (model.sharedModel.insertCell + addWire): the litegraph "drag out a node" gesture.
    }
  }, []);
  const onSelectionChange: OnSelectionChangeFunc<CellNode, DagEdge> = useCallback(({ nodes: selected }) => {
    // TODO: mirror the selection to the notebook panel's activeCell (and back) so both views agree.
    void selected;
  }, []);
  useOnSelectionChange({ onChange: onSelectionChange });
  // Backspace on a selected node must not delete the cell's wires behind its back: only selected edges go.
  const onBeforeDelete: OnBeforeDelete<CellNode, DagEdge> = useCallback(
    async ({ edges: toDelete }) => ({ nodes: [], edges: toDelete.filter(e => e.selected) }),
    []
  );
  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => setNotebookMetadata(model, { ...getNotebookMetadata(model), viewport }),
    [model]
  );
  return (
    <ReactFlow<CellNode, DagEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onInit={onInit}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onReconnect={onReconnect}
      onBeforeDelete={onBeforeDelete}
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

export function DagCanvas(props: IDagCanvasProps): JSX.Element {
  return (
    <CellNodeContext.Provider value={props.nodeContext}>
      <ReactFlowProvider>
        <DagFlow {...props} />
      </ReactFlowProvider>
    </CellNodeContext.Provider>
  );
}
