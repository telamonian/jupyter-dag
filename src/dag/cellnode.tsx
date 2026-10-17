/**
 * The React Flow node that shows a notebook cell: a Lumino cell widget mounted inside a React
 * component.
 *
 * The DAG canvas is React (React Flow), while JupyterLab's cells are Lumino widgets built on the
 * shared cell model. Each node therefore creates a real `Cell` widget for its cell, as the
 * notebook panel would, and attaches it to a `div` that React owns. The model is the same
 * object the notebook panel edits, so typing in either view shows up in the other.
 *
 * @module
 */
import React, { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, NodeToolbar, Position, useNodeConnections } from '@xyflow/react';
import type { HandleProps, Node, NodeProps, NodeTypes } from '@xyflow/react';
import { Cell } from '@jupyterlab/cells';
import type { ICellModel, ICodeCellModel, IMarkdownCellModel, IRawCellModel } from '@jupyterlab/cells';
import { StaticNotebook } from '@jupyterlab/notebook';
import type { NotebookPanel } from '@jupyterlab/notebook';
import { SimplifiedOutputArea } from '@jupyterlab/outputarea';
import type { OutputArea } from '@jupyterlab/outputarea';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { ITranslator, TranslationBundle } from '@jupyterlab/translation';
import { LabIcon, clearIcon, deleteIcon, runIcon } from '@jupyterlab/ui-components';
import type { ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { MessageLoop } from '@lumino/messaging';
import type { DagNodeState, IDagGraphChange, IDagGraphModel } from './tokens';

/**
 * The React Flow node type for a cell.
 *
 * @remarks
 * A node carries no data: everything it shows is read from the graph model by its id, which is the
 * cell id. That keeps node objects stable across state changes, so React Flow never remounts a
 * node (and its Lumino widget) just because a cell's execution state changed.
 */
export type CellNode = Node<Record<string, never>, 'cellNode'>;

/** What a node needs from the DAG panel, provided once through {@link CellNodeContext}. */
export interface ICellNodeContext {
  /** Creates cell widgets; the notebook's `NotebookPanel.IContentFactory`. */
  contentFactory: NotebookPanel.IContentFactory;
  /** Renders outputs; the document's rendermime, cloned with the document's resolver. */
  rendermime: IRenderMimeRegistry;
  /** The application translator, for the cell widgets. */
  translator: ITranslator;
  /** The extension's translation bundle, for the toolbar tooltips. */
  trans: TranslationBundle;
  /** The graph model, for cell lookup and execution state. */
  graph: IDagGraphModel;
  /** Show only the outputs of code cells, no editor. */
  outputOnly: boolean;
  /**
   * Register the live widget for a cell, or unregister it with `null`; output-only nodes, which
   * are not executable, register nothing.
   *
   * @param id - The cell id.
   * @param cell - The widget, or `null` on unmount.
   */
  registerWidget(id: string, cell: Cell | null): void;
  /**
   * Run a cell and everything downstream of it; the node toolbar's first button.
   *
   * @param id - The cell id.
   */
  onRunDownstream(id: string): void;
  /**
   * Delete the cell from the notebook; the "Remove cell" button.
   *
   * @param id - The cell id.
   */
  onRemoveCell(id: string): void;
  /**
   * Remove every wire into and out of the cell; the "Remove edges" button.
   *
   * @param id - The cell id.
   */
  onRemoveEdges(id: string): void;
  /**
   * Clear a code cell's outputs; the "Clear output" button.
   *
   * @param id - The cell id.
   */
  onClearOutput(id: string): void;
}
/** The context nodes read their {@link ICellNodeContext} from; `DagCanvas` provides it. */
export const CellNodeContext = React.createContext<ICellNodeContext | null>(null);
/**
 * The node context, for components rendered inside the canvas (nodes and edges).
 *
 * @returns The context `DagCanvas` provided.
 * @throws Error when called outside the provider.
 */
export function useCellNodeContext(): ICellNodeContext {
  const ctx = useContext(CellNodeContext);
  if (!ctx) {
    throw new Error('CellNodeView must be rendered inside DagCanvas');
  }
  return ctx;
}

/**
 * Connect a Lumino signal for the lifetime of the component.
 *
 * @typeParam T - The signal's sender type.
 * @typeParam U - The signal's argument type.
 * @param signal - The signal to connect to.
 * @param slot - The handler; wrap it in `useCallback` so the connection is not remade every render.
 *
 * @remarks
 * A Lumino signal outlives any React render, so the connection lives in an effect whose cleanup
 * disconnects it.
 */
export function useLuminoSignal<T, U>(signal: ISignal<T, U>, slot: (sender: T, args: U) => void): void {
  useEffect(() => {
    signal.connect(slot);
    return () => {
      signal.disconnect(slot);
    };
  }, [signal, slot]);
}

/**
 * This cell's execution state, re-read when the graph reports a state change for it.
 *
 * @param graph - The graph model.
 * @param cellId - The cell id.
 * @returns The current {@link DagNodeState}; the component re-renders when it changes.
 *
 * @remarks
 * A subscription per node is cheaper than it looks (an `includes` on the changed ids, per node per
 * change), and a `'state'` change re-renders only the nodes it names, not the node array.
 */
function useNodeState(graph: IDagGraphModel, cellId: string): DagNodeState {
  const [state, setState] = useState(() => graph.stateOf(cellId));
  const onChange = useCallback(
    (_: unknown, change: IDagGraphChange) => {
      if (change.type === 'state' && change.cellIds?.includes(cellId)) {
        setState(graph.stateOf(cellId));
      }
    },
    [graph, cellId]
  );
  useLuminoSignal(graph.changed, onChange);
  return state;
}

/**
 * Create a live Lumino cell widget over the shared cell model.
 *
 * @param ctx - The node context, for the content factory, rendermime and translator.
 * @param model - The cell model; its `type` picks the widget class.
 * @returns A `CodeCell`, `MarkdownCell` or `RawCell` that is not yet attached anywhere.
 *
 * @remarks
 * Mirrors `StaticNotebook._createCodeCell` and its siblings
 * (`@jupyterlab/notebook/src/widget.ts:720`, `:762`, `:790`), going through the same content
 * factory (`widget.ts:1293-1303`) so any extension that customises cell widgets applies here too.
 * The editor configuration is the static default (`StaticNotebook.defaultEditorConfig`,
 * `widget.ts:1327`) rather than the user's notebook settings. `placeholder` is `false`: the
 * notebook panel creates cells as placeholders when windowing is on (`widget.ts:731`) and fills
 * them in as they scroll into view; a node has no scrolling container to drive that, so the
 * editor is built at once.
 */
export function createCellWidget(ctx: ICellNodeContext, model: ICellModel): Cell {
  const { contentFactory, rendermime, translator } = ctx;
  switch (model.type) {
    case 'code':
      return contentFactory.createCodeCell({
        model: model as ICodeCellModel,
        contentFactory,
        rendermime,
        editorConfig: StaticNotebook.defaultEditorConfig.code,
        placeholder: false,
        translator
      });
    case 'markdown':
      return contentFactory.createMarkdownCell({
        model: model as IMarkdownCellModel,
        contentFactory,
        rendermime,
        editorConfig: StaticNotebook.defaultEditorConfig.markdown,
        placeholder: false,
        translator
      });
    default:
      return contentFactory.createRawCell({
        model: model as IRawCellModel,
        contentFactory,
        editorConfig: StaticNotebook.defaultEditorConfig.raw,
        placeholder: false,
        translator
      });
  }
}
/**
 * What a code cell's node shows when the `outputOnlyNodes` setting is on: the outputs alone.
 *
 * @param ctx - The node context, for the content factory and rendermime.
 * @param model - A code cell model; its `outputs` are shown.
 * @returns A `SimplifiedOutputArea` (`@jupyterlab/outputarea/src/widget.ts:889`), the output area
 * without the prompts, over the cell's output model.
 *
 * @remarks
 * The fallback for when a second editor on one model proves too fragile.
 */
export function createOutputOnlyWidget(ctx: ICellNodeContext, model: ICodeCellModel): OutputArea {
  return new SimplifiedOutputArea({
    model: model.outputs,
    contentFactory: ctx.contentFactory,
    rendermime: ctx.rendermime
  });
}

/** "Remove edges": two nodes whose connector is struck through, in JupyterLab's icon style. */
export const unwireIcon = new LabIcon({
  name: 'jupyter-dag:unwire',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161" stroke="#616161" stroke-width="2"><circle cx="5" cy="12" r="3" stroke="none"/><circle cx="19" cy="12" r="3" stroke="none"/><path d="M8 12h2.5M13.5 12H16M9 17l6-10" fill="none"/></g></svg>'
});

/** Props of {@link NodeButton}. */
export interface INodeButtonProps {
  /** The icon; the button has no label. */
  icon: LabIcon;
  /** The tooltip, also the accessible name. */
  title: string;
  /** What the button does. */
  onClick: () => void;
  /** Whether the button is greyed out. */
  disabled?: boolean;
  /** Use the 14px icon size instead of 16px, for the edge button. */
  small?: boolean;
}

/**
 * An icon-only button for the node and edge toolbars.
 *
 * @param props - See {@link INodeButtonProps}.
 * @returns A `jp-Button` with the icon inside and the tooltip as its `title`.
 *
 * @remarks
 * A plain button rather than `ToolbarButtonComponent`, which wraps the `@jupyter/react-components`
 * web component (`@jupyterlab/ui-components/src/components/toolbar.tsx:4`) and can only be sized
 * through `::part`. The click does not propagate: the toolbars are React portals, and a synthetic
 * click would still bubble into React Flow's node or edge click handler, which raises error 012
 * or 016 once the element the button removed is gone. After the action, focus moves to the panel:
 * a button that removed its own node or edge is unmounted, and focus would otherwise fall to
 * `body`, outside the selector of the view's `Z` undo binding.
 *
 * @see https://reactflow.dev/error
 */
export function NodeButton({ icon, title, onClick, disabled = false, small = false }: INodeButtonProps): JSX.Element {
  return (
    <button
      className="jp-Button jp-mod-minimal jp-mod-small jp-DagNodeButton"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={event => {
        event.stopPropagation();
        onClick();
        const panel = event.currentTarget.closest('.jp-DagPanel');
        if (panel instanceof HTMLElement) {
          panel.focus(); // the button may be gone now; keep focus in the view for its `Z` binding
        }
      }}
    >
      <icon.react tag="span" elementSize={small ? 'small' : 'normal'} />
    </button>
  );
}

/**
 * A connection handle on a node, styled as a DAG port.
 *
 * @param props - React Flow's `Handle` props: `type` (`'source'` or `'target'`), `position`, `id`.
 * @returns The handle element.
 * @see https://reactflow.dev/api-reference/components/handle
 */
export const CellPort = (props: HandleProps): JSX.Element => <Handle {...props} className="jp-DagCellNode-port" />;

/**
 * The node component: a target port, the header strip, the cell widget's host, a source port, and
 * a toolbar under the node while it is selected.
 *
 * @param props - React Flow's `NodeProps`: `id` is the cell id, `selected` drives the resizer and toolbar.
 * @returns The node element.
 *
 * @remarks
 * The toolbar. `NodeToolbar` is a portal into React Flow's renderer pane, placed `offset` pixels
 * under the node at screen size; without `isVisible` React Flow shows it only while this is the
 * single selected node, so a multi-selection shows no buttons. The 6px offset clears the source
 * port, which extends 3px below the border, and the hover ring. "Remove edges" is greyed out
 * when `useNodeConnections` reports none, which updates as wires come and go while the node stays
 * selected; "Clear output" only applies to code cells, and "Remove cell" is greyed out for a cell
 * whose metadata says `deletable: false`, which the notebook honours too.
 *
 * Mounting a Lumino widget in React. The mount effect is a `useLayoutEffect` so that `detach`
 * still finds the host node in the DOM: React runs a layout effect's cleanup during the commit
 * that removes the component, while the host `div` is still there, whereas a passive `useEffect`
 * cleanup runs after the DOM has been removed. `Widget.attach(widget, host)`
 * (`@lumino/widgets/src/widget.ts:1113`) inserts the widget's node into `host` and sends the
 * before/after-attach messages; it throws unless the host is itself in the document
 * (`widget.ts:1125`). `Widget.detach` (`widget.ts:1141`) likewise throws if the widget's node is no
 * longer connected (`widget.ts:1145-1146`).
 *
 * Resizing without a parent. A widget inside a Lumino layout receives resize messages from its
 * parent; this one has none, so the component sends `ResizeMessage.UnknownSize`
 * (`@lumino/widgets/src/widget.ts:1093`) itself once after attaching and again whenever a
 * `ResizeObserver` sees the host change size. The initial one is sent synchronously
 * (`MessageLoop.sendMessage`, `@lumino/messaging/src/index.ts:241`) so the editor measures before
 * the first paint. The observer ones are posted (`MessageLoop.postMessage`, `index.ts:276`), which
 * queues them for the next turn of the event loop instead of running a relayout inside the
 * observer callback; the editor's own measurement then batches repeated requests.
 *
 * Disposing a cell widget never disposes the shared model, which belongs to the notebook. The
 * detach in the cleanup unmounts the cell's collapsers, which are `ReactWidget`s
 * (`@jupyterlab/cells/src/collapser.tsx:42`), inside React Flow's own commit; React's development
 * build logs a warning about that race on every node unmount. Avoiding it would mean detaching
 * registered widgets from the panel when the graph announces a removal, before React renders it.
 *
 * @see https://react.dev/reference/react/useLayoutEffect
 * @see https://reactflow.dev/api-reference/types/node-props
 * @see https://reactflow.dev/api-reference/components/node-toolbar
 */
function CellNodeView({ id, selected }: NodeProps<CellNode>): JSX.Element {
  const ctx = useCellNodeContext();
  const model = ctx.graph.findCell(id);
  const state = useNodeState(ctx.graph, id);
  const connections = useNodeConnections();
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!model || !host) {
      return;
    }
    const widget =
      ctx.outputOnly && model.type === 'code'
        ? createOutputOnlyWidget(ctx, model as ICodeCellModel)
        : createCellWidget(ctx, model);
    Widget.attach(widget, host);
    MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize);
    if (widget instanceof Cell) {
      ctx.registerWidget(id, widget);
    }
    const ro = new ResizeObserver(() => MessageLoop.postMessage(widget, Widget.ResizeMessage.UnknownSize));
    ro.observe(host);
    return () => {
      ro.disconnect();
      ctx.registerWidget(id, null);
      if (widget.isAttached) {
        Widget.detach(widget);
      }
      widget.dispose();
    };
  }, [ctx, id, model]);
  return (
    <div className={`jp-DagCellNode jp-DagCellNode-${state}`}>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={80} />
      {selected ? (
        <NodeToolbar position={Position.Bottom} offset={6} className="jp-DagCellNode-toolbar nopan nowheel">
          <NodeButton icon={runIcon} title={ctx.trans.__('Run downstream')} onClick={() => ctx.onRunDownstream(id)} />
          <NodeButton
            icon={deleteIcon}
            title={ctx.trans.__('Remove cell')}
            disabled={model?.getMetadata('deletable') === false}
            onClick={() => ctx.onRemoveCell(id)}
          />
          <NodeButton
            icon={unwireIcon}
            title={ctx.trans.__('Remove edges')}
            disabled={connections.length === 0}
            onClick={() => ctx.onRemoveEdges(id)}
          />
          <NodeButton
            icon={clearIcon}
            title={ctx.trans.__('Clear output')}
            disabled={model?.type !== 'code'}
            onClick={() => ctx.onClearOutput(id)}
          />
        </NodeToolbar>
      ) : null}
      <CellPort type="target" position={Position.Top} id="in" />
      <div className="jp-DagCellNode-dragHandle">{model?.type}</div>
      <div ref={hostRef} className="jp-DagCellNode-host nodrag nowheel nopan" />
      <CellPort type="source" position={Position.Bottom} id="out" />
    </div>
  );
}

/**
 * The node types passed to React Flow: one, `cellNode`.
 *
 * @remarks
 * Module scope because React Flow compares `nodeTypes` by identity: a new object on every render
 * would make every node a new component type, which unmounts and remounts each node and with it
 * the Lumino cell inside. `memo` additionally skips re-rendering a node whose props are unchanged,
 * which is most nodes on most updates.
 *
 * @see https://reactflow.dev/error#002
 */
export const nodeTypes: NodeTypes = { cellNode: memo(CellNodeView) };
