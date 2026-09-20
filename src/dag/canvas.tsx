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

function wireToEdge(wire: IWire): Edge {
  return { id: wire.id, source: wire.source, target: wire.target };
}
function cellToNode(cell: ICellModel, index: number): CellNode {
  const meta = getCellMetadata(cell);
  return {
    id: cell.id,
    type: 'cellNode',
    position: meta.position ?? { x: 0, y: index * 160 },
    width: meta.width,
    height: meta.height,
    deletable: false, // cells are deleted in the notebook, never from the canvas; the cell list drives 'nodes'
    data: {}
  };
}

export interface IDagCanvasProps {
  graph: DagGraphModel;
  nodeContext: ICellNodeContext;
  settings: IDagSettings;
  /** Emitted by the document (toolbar / command) to run auto-layout. */
  layoutRequested: ISignal<unknown, void>;
}

function DagFlow({ graph, settings, layoutRequested }: IDagCanvasProps): JSX.Element {
  const model = graph.notebook;
  const [nodes, setNodes] = useState<CellNode[]>(() => Array.from(model.cells, cellToNode));
  const [edges, setEdges] = useState<Edge[]>(() => graph.wires.map(wireToEdge));
  const [direction, setDirection] = useState<LayoutDirection>(
    () => getNotebookMetadata(model).direction ?? settings.layoutDirection
  );
  const [defaultViewport] = useState(() => getNotebookMetadata(model).viewport); // React Flow reads it at mount only
  const initialized = useNodesInitialized();
  const hasSize = useStore(s => s.width > 0 && s.height > 0);
  const instance = useReactFlow<CellNode, Edge>();

  // Nodes and edges follow the model; existing objects are kept so React Flow keeps positions,
  // measurements and selection. Execution state is read by each node itself.
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
      // Persist the computed positions (drag-end is the only other writer), as one undoable transaction.
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
      // Finished drags and resizes are persisted together: a multi-node drag ends with one change per node.
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
  // Wires live in the model: writes below reach the canvas again through `refresh`.
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
      removeWire(graph, oldEdge.source, oldEdge.target); // first, so the cycle check below sees the graph without it
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

export function DagCanvas(props: IDagCanvasProps): JSX.Element {
  return (
    <CellNodeContext.Provider value={props.nodeContext}>
      <ReactFlowProvider>
        <DagFlow {...props} />
      </ReactFlowProvider>
    </CellNodeContext.Provider>
  );
}
