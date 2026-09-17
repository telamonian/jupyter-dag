import React, { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, NodeToolbar, Position } from '@xyflow/react';
import type { HandleProps, Node, NodeProps, NodeTypes } from '@xyflow/react';
import { Cell } from '@jupyterlab/cells';
import type { ICellModel, ICodeCellModel, IMarkdownCellModel, IRawCellModel } from '@jupyterlab/cells';
import { StaticNotebook } from '@jupyterlab/notebook';
import type { NotebookPanel } from '@jupyterlab/notebook';
import { SimplifiedOutputArea } from '@jupyterlab/outputarea';
import type { OutputArea } from '@jupyterlab/outputarea';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { ITranslator } from '@jupyterlab/translation';
import type { ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { MessageLoop } from '@lumino/messaging';
import type { DagNodeState, IDagGraphChange, IDagGraphModel } from './tokens';

/** A node carries no data: everything it shows is read from the graph model by its id (= cell id). */
export type CellNode = Node<Record<string, never>, 'cellNode'>;

export interface ICellNodeContext {
  contentFactory: NotebookPanel.IContentFactory;
  rendermime: IRenderMimeRegistry;
  translator: ITranslator;
  graph: IDagGraphModel;
  /** Show only the outputs of code cells, no editor. */
  outputOnly: boolean;
  /** Only Cell widgets are executable; output-only nodes are not registered. */
  registerWidget(id: string, cell: Cell | null): void;
  onRunDownstream(id: string): void;
}
export const CellNodeContext = React.createContext<ICellNodeContext | null>(null);
function useCellNodeContext(): ICellNodeContext {
  const ctx = useContext(CellNodeContext);
  if (!ctx) {
    throw new Error('CellNodeView must be rendered inside DagCanvas');
  }
  return ctx;
}

/** Connect a Lumino signal for the lifetime of the component (or until `slot` changes). */
export function useLuminoSignal<T, U>(signal: ISignal<T, U>, slot: (sender: T, args: U) => void): void {
  useEffect(() => {
    signal.connect(slot);
    return () => {
      signal.disconnect(slot);
    };
  }, [signal, slot]);
}

/** This cell's execution state, re-read when the graph reports a state change for it. */
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

/** A live Lumino cell widget over the SHARED cell model, built like StaticNotebook does. */
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
/** Fallback node content when a second editor on one model proves too fragile: outputs only. */
export function createOutputOnlyWidget(ctx: ICellNodeContext, model: ICodeCellModel): OutputArea {
  return new SimplifiedOutputArea({
    model: model.outputs,
    contentFactory: ctx.contentFactory,
    rendermime: ctx.rendermime
  });
}

export const CellPort = (props: HandleProps): JSX.Element => <Handle {...props} className="jp-DagCellNode-port" />;

function CellNodeView({ id, selected }: NodeProps<CellNode>): JSX.Element {
  const ctx = useCellNodeContext();
  const model = ctx.graph.findCell(id);
  const state = useNodeState(ctx.graph, id);
  const hostRef = useRef<HTMLDivElement>(null);
  // Layout effect: the cleanup then runs while the host is still in the DOM, which Widget.detach requires.
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
    MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize); // no Lumino parent: pump resize ourselves
    if (widget instanceof Cell) {
      ctx.registerWidget(id, widget);
    }
    // Posted, not sent: the editor relayout then happens outside the observer callback and repeats coalesce.
    const ro = new ResizeObserver(() => MessageLoop.postMessage(widget, Widget.ResizeMessage.UnknownSize));
    ro.observe(host);
    return () => {
      ro.disconnect();
      ctx.registerWidget(id, null);
      if (widget.isAttached) {
        Widget.detach(widget);
      }
      widget.dispose(); // never disposes the shared model
    };
  }, [ctx, id, model]);
  return (
    <div className={`jp-DagCellNode jp-DagCellNode-${state}`}>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={80} />
      {selected ? (
        <NodeToolbar isVisible position={Position.Top}>
          <button className="jp-Button" onClick={() => ctx.onRunDownstream(id)}>
            Run downstream
          </button>
        </NodeToolbar>
      ) : null}
      <CellPort type="target" position={Position.Top} id="in" />
      <div className="jp-DagCellNode-dragHandle">{model?.type}</div>
      <div ref={hostRef} className="jp-DagCellNode-host nodrag nowheel nopan" />
      <CellPort type="source" position={Position.Bottom} id="out" />
    </div>
  );
}

// Module scope: a new nodeTypes identity per render remounts every node and destroys the Lumino cells.
export const nodeTypes: NodeTypes = { cellNode: memo(CellNodeView) };
