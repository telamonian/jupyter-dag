import { KernelMessage } from '@jupyterlab/services';
import type { Kernel } from '@jupyterlab/services';
import type { ISessionContext } from '@jupyterlab/apputils';
import type { JSONObject, JSONValue } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import type { ISignal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import type { AnalyzeChannel } from './tokens';

// Must match jupyter_dag/protocol.py verbatim; jupyter_dag/tests/test_protocol.py checks.
export const KERNEL_NAME = 'jupyter-dag';
export const COMM_TARGET = 'jupyter-dag';
export const FEATURE_ANALYZE = 'cell analysis';
export const FEATURE_NAMESPACE_DELETE = 'namespace delete';
export const FEATURE_NAMESPACE_DELTA = 'namespace delta';
export const ANALYZE_REQUEST = 'analyze_request';
export const ANALYZE_REPLY = 'analyze_reply';

export interface IAnalyzeCellInput {
  cell_id: string;
  code: string;
}
export interface IAnalyzeRequestContent {
  cells: IAnalyzeCellInput[];
}
export interface IAnalyzedCellOk {
  cell_id: string;
  status: 'ok' | 'opaque';
  defined: string[];
  referenced: string[];
  deleted: string[];
  dynamic: boolean;
}
export interface IAnalyzedCellError {
  cell_id: string;
  status: 'error';
  ename: string;
  evalue: string;
}
export type IAnalyzedCell = IAnalyzedCellOk | IAnalyzedCellError;
export interface IAnalyzeReplyOk extends KernelMessage.IReplyOkContent {
  cells: IAnalyzedCell[];
}
// ReplyContent<T> is not exported from @jupyterlab/services; spell the union out.
export type IAnalyzeReplyContent =
  IAnalyzeReplyOk | KernelMessage.IReplyErrorContent | KernelMessage.IReplyAbortContent;
export interface INamespaceDelta {
  added: string[];
  removed: string[];
}
export type IDagExecuteRequestContent = KernelMessage.IExecuteRequestMsg['content'] & {
  namespace_delete?: string[];
  namespace_set?: JSONObject;
};
export type IDagExecuteReplyContent = KernelMessage.IExecuteReplyMsg['content'] & { namespace_delta?: INamespaceDelta };

export function readNamespaceDelta(reply: KernelMessage.IExecuteReplyMsg | undefined): INamespaceDelta | undefined {
  if (!reply || reply.content.status !== 'ok') {
    return undefined;
  }
  return (reply.content as IDagExecuteReplyContent).namespace_delta;
}

/** One way of carrying the DAG payloads to a kernel; the client picks it from the advertised features. */
export interface IDagTransport extends IDisposable {
  readonly namespaceDelta: ISignal<IDagTransport, INamespaceDelta>;
  analyze(content: IAnalyzeRequestContent): Promise<IAnalyzeReplyOk>;
  namespaceDelete(names: string[]): Promise<void>;
}

// KernelMessage's message-type unions are closed, so a known request type stands in for analyze_request.
type ShellStandIn = KernelMessage.IIsCompleteRequestMsg;
type ControlStandIn = KernelMessage.IDebugRequestMsg;

/** analyze_request as a real shell (or control) message: the protocol as designed. */
export class ShellTransport implements IDagTransport {
  constructor(
    private _kernel: Kernel.IKernelConnection,
    private _channel: AnalyzeChannel = 'shell'
  ) {
    // The kernel attaches namespace_delta to every execute_reply, whoever sent the request.
    _kernel.anyMessage.connect(this._onAnyMessage, this);
  }
  get namespaceDelta(): ISignal<this, INamespaceDelta> {
    return this._delta;
  }
  async analyze(content: IAnalyzeRequestContent): Promise<IAnalyzeReplyOk> {
    const kernel = this._kernel;
    const msg = KernelMessage.createMessage<ShellStandIn>({
      session: kernel.clientId,
      username: kernel.username,
      subshellId: kernel.subshellId,
      msgType: ANALYZE_REQUEST as 'is_complete_request',
      channel: this._channel as 'shell',
      content: content as unknown as ShellStandIn['content']
    });
    const future =
      this._channel === 'control'
        ? kernel.sendControlMessage(msg as unknown as ControlStandIn, true, true)
        : kernel.sendShellMessage(msg, true, true);
    const reply = (await future.done).content as unknown as IAnalyzeReplyContent;
    if (reply.status !== 'ok') {
      throw new Error(`analyze_request failed: ${reply.status}`);
    }
    return reply;
  }
  /** 'Purge without running': a silent execute of empty code carrying namespace_delete. */
  async namespaceDelete(names: string[]): Promise<void> {
    const content: IDagExecuteRequestContent = {
      code: '',
      silent: true,
      store_history: false,
      namespace_delete: names
    };
    await this._kernel.requestExecute(content as unknown as KernelMessage.IExecuteRequestMsg['content'], true).done;
  }
  private _onAnyMessage(_: unknown, { msg, direction }: Kernel.IAnyMessageArgs): void {
    if (direction === 'recv' && KernelMessage.isExecuteReplyMsg(msg)) {
      const delta = readNamespaceDelta(msg);
      if (delta) {
        this._delta.emit(delta);
      }
    }
  }
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this); // also drops the anyMessage connection
  }
  private _delta = new Signal<this, INamespaceDelta>(this);
  private _isDisposed = false;
}

interface ICommPayload {
  type: string;
  supported_features?: string[];
}

/**
 * The no-protocol-change prototype: the same payloads over the `jupyter-dag` comm target.
 * Replies ride the request's comm future (ipykernel stamps them with the request as parent);
 * kernel-initiated messages (namespace_delta) arrive through comm.onMsg.
 */
export class CommTransport implements IDagTransport {
  constructor(private _kernel: Kernel.IKernelConnection) {
    // TODO: kernel-initiated comms (the kernel opening `jupyter-dag` towards the frontend, e.g. right
    // after `%load_ext jupyter_dag`), so the kernel can push without the frontend opening a comm first.
    _kernel.registerCommTarget(COMM_TARGET, this._onKernelInitiated);
  }
  private _onKernelInitiated = (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg): void => {
    void msg.content.target_name;
    void comm; // TODO: adopt it as this._comm and attach onMsg / onClose exactly as open() does
  };
  get namespaceDelta(): ISignal<this, INamespaceDelta> {
    return this._delta;
  }
  /** Advertised by the kernel on comm open (a stock kernel after %load_ext never updates kernel_info). */
  get features(): ReadonlySet<string> {
    return this._features;
  }
  async open(): Promise<Kernel.IComm> {
    const kernel = this._kernel;
    if (!kernel.handleComms) {
      throw new Error('comms are disabled on this kernel connection');
    }
    const comm = kernel.createComm(COMM_TARGET); // a fresh comm id each time: reuse after reconnect throws
    comm.onMsg = (msg: KernelMessage.ICommMsgMsg) => {
      const data = msg.content.data as unknown as ICommPayload;
      if (data.type === 'namespace_delta') {
        this._delta.emit(data as unknown as INamespaceDelta);
      } else if (data.type === 'features') {
        this._features = new Set(data.supported_features ?? []);
      }
    };
    comm.onClose = () => {
      this._comm = null;
    };
    await comm.open().done;
    if (comm.isDisposed) {
      throw new Error(`the kernel has no '${COMM_TARGET}' comm target`);
    }
    this._comm = comm;
    return comm;
  }
  async analyze(content: IAnalyzeRequestContent): Promise<IAnalyzeReplyOk> {
    const comm = this._comm ?? (await this.open());
    let reply: IAnalyzeReplyContent | undefined;
    const future = comm.send({ type: ANALYZE_REQUEST, ...content } as unknown as JSONValue);
    future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
      if (KernelMessage.isCommMsgMsg(msg) && msg.content.comm_id === comm.commId) {
        reply = msg.content.data as unknown as IAnalyzeReplyContent;
      }
    };
    await future.done; // the kernel replies on the comm while handling the request, so it precedes `done`
    if (!reply) {
      throw new Error('no analyze reply on the comm');
    }
    if (reply.status !== 'ok') {
      throw new Error(`analyze failed: ${reply.status}`);
    }
    return reply;
  }
  async namespaceDelete(names: string[]): Promise<void> {
    const comm = this._comm ?? (await this.open());
    await comm.send({ type: 'namespace_delete', names } as unknown as JSONValue).done;
  }
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._kernel.removeCommTarget(COMM_TARGET, this._onKernelInitiated);
    this._comm?.close();
    this._comm?.dispose();
    Signal.clearData(this);
  }
  private _comm: Kernel.IComm | null = null;
  private _delta = new Signal<this, INamespaceDelta>(this);
  private _features = new Set<string>();
  private _isDisposed = false;
}

/** Per-session client: feature detection from kernel_info, one transport, and the namespace_delta stream. */
export class DagKernelClient implements IDisposable {
  constructor(sessionContext: ISessionContext, analyzeChannel: AnalyzeChannel = 'shell') {
    this._sessionContext = sessionContext;
    this._analyzeChannel = analyzeChannel;
    sessionContext.kernelChanged.connect(this._onKernelChanged, this);
    sessionContext.statusChanged.connect(this._onStatusChanged, this);
  }
  get kernel(): Kernel.IKernelConnection | null | undefined {
    return this._sessionContext.session?.kernel;
  }
  get features(): ReadonlySet<string> {
    return this._features;
  }
  get namespaceDelta(): ISignal<this, INamespaceDelta> {
    return this._namespaceDelta;
  }
  /** Emitted after every detection: kernel start, change or restart, and explicit detectFeatures() calls. */
  get featuresChanged(): ISignal<this, ReadonlySet<string>> {
    return this._featuresChanged;
  }
  async detectFeatures(): Promise<void> {
    const generation = ++this._generation; // a newer call (kernel change, restart) supersedes this one
    this._transport?.dispose();
    this._transport = null;
    this._features = new Set();
    const kernel = this.kernel;
    if (kernel) {
      // kernel_info_reply.supported_features is the source of truth; `info` is the connection's first reply.
      const features = new Set((await kernel.info).supported_features ?? []);
      const transport = await this._openTransport(kernel, features);
      if (generation !== this._generation) {
        transport?.dispose();
        return;
      }
      this._features = features;
      this._transport = transport;
      transport?.namespaceDelta.connect((_, d) => this._namespaceDelta.emit(d));
    }
    this._featuresChanged.emit(this._features);
  }
  /** Per-cell defined/referenced names, or nothing when the kernel offers no analysis. */
  async analyze(cells: IAnalyzeCellInput[]): Promise<IAnalyzedCell[]> {
    return this._transport ? (await this._transport.analyze({ cells })).cells : [];
  }
  /** Unbind names in the kernel, if it supports that. */
  async namespaceDelete(names: string[]): Promise<void> {
    await this._transport?.namespaceDelete(names);
  }
  private async _openTransport(kernel: Kernel.IKernelConnection, features: Set<string>): Promise<IDagTransport | null> {
    if (features.has(FEATURE_ANALYZE)) {
      return new ShellTransport(kernel, this._analyzeChannel);
    }
    // e.g. a stock kernel after `%load_ext jupyter_dag`: kernel_info was answered before the extension loaded.
    const comm = new CommTransport(kernel);
    try {
      await comm.open();
    } catch {
      comm.dispose();
      return null;
    }
    comm.features.forEach(f => features.add(f));
    return comm;
  }
  private _onKernelChanged(): void {
    void this.detectFeatures();
  }
  private _onStatusChanged(_: ISessionContext, status: Kernel.Status): void {
    if (status === 'restarting' || status === 'autorestarting') {
      this._transport?.dispose();
      this._transport = null;
      this._redetect = true;
    } else if (status === 'idle' && this._redetect) {
      this._redetect = false;
      void this.detectFeatures();
    }
  }
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._transport?.dispose();
    Signal.clearData(this);
  }
  private _sessionContext: ISessionContext;
  private _analyzeChannel: AnalyzeChannel;
  private _features = new Set<string>();
  private _transport: IDagTransport | null = null;
  private _namespaceDelta = new Signal<this, INamespaceDelta>(this);
  private _featuresChanged = new Signal<this, ReadonlySet<string>>(this);
  private _redetect = false;
  private _generation = 0;
  private _isDisposed = false;
}
