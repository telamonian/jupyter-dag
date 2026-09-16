import React, { memo, useContext, useLayoutEffect, useRef } from 'react';
import { Handle, NodeResizer, NodeToolbar, Position } from '@xyflow/react';
import type { HandleProps, Node, NodeProps, NodeTypes } from '@xyflow/react';
import type { Cell, ICellModel, ICodeCellModel, IMarkdownCellModel, IRawCellModel } from '@jupyterlab/cells';
import { StaticNotebook } from '@jupyterlab/notebook';
import type { NotebookPanel } from '@jupyterlab/notebook';
import { SimplifiedOutputArea } from '@jupyterlab/outputarea';
import type { OutputArea } from '@jupyterlab/outputarea';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { ITranslator } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';
import { MessageLoop } from '@lumino/messaging';
import type { DagNodeState } from './tokens';

// Type alias (not interface): NodeData must satisfy Record<string, unknown>.
export type CellNodeData = {
  cellId: string;
  cellType: string;
  executionCount: number | null;
  state: DagNodeState;
  outputOnly: boolean;
};
export type CellNode = Node<CellNodeData, 'cellNode'>;

export interface ICellNodeContext {
  contentFactory: NotebookPanel.IContentFactory;
  rendermime: IRenderMimeRegistry;
  translator: ITranslator;
  findCell(id: string): ICellModel | undefined;
  registerWidget(id: string, widget: Cell | OutputArea | null): void;
  onRunDownstream(id: string): void;
}
export const CellNodeContext = React.createContext<ICellNodeContext | null>(null);

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

function CellNodeView({ data, selected }: NodeProps<CellNode>): JSX.Element {
  const ctx = useContext(CellNodeContext);
  const hostRef = useRef<HTMLDivElement>(null);
  // Layout effect: the cleanup then runs while the host is still in the DOM, which Widget.detach requires.
  useLayoutEffect(() => {
    const model = ctx?.findCell(data.cellId);
    const host = hostRef.current;
    if (!ctx || !model || !host) {
      return;
    }
    const widget =
      data.outputOnly && model.type === 'code'
        ? createOutputOnlyWidget(ctx, model as ICodeCellModel)
        : createCellWidget(ctx, model);
    Widget.attach(widget, host);
    MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize); // no Lumino parent: pump resize ourselves
    ctx.registerWidget(data.cellId, widget);
    const ro = new ResizeObserver(() => MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize));
    ro.observe(host);
    return () => {
      ro.disconnect();
      ctx.registerWidget(data.cellId, null);
      if (widget.isAttached) {
        Widget.detach(widget);
      }
      widget.dispose(); // never disposes the shared model
    };
  }, [ctx, data.cellId, data.outputOnly]);
  return (
    <div className={`jp-DagCellNode jp-DagCellNode-${data.state}`}>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={80} />
      {selected ? (
        <NodeToolbar isVisible position={Position.Top}>
          <button className="jp-Button" onClick={() => ctx?.onRunDownstream(data.cellId)}>
            Run downstream
          </button>
        </NodeToolbar>
      ) : null}
      <CellPort type="target" position={Position.Top} id="in" />
      <div className="jp-DagCellNode-dragHandle">
        {data.cellType} [{data.executionCount ?? ' '}]
      </div>
      <div ref={hostRef} className="jp-DagCellNode-host nodrag nowheel nopan" />
      <CellPort type="source" position={Position.Bottom} id="out" />
    </div>
  );
}

// Module scope: a new nodeTypes identity per render remounts every node and destroys the Lumino cells.
export const nodeTypes: NodeTypes = { cellNode: memo(CellNodeView) };
