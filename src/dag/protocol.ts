/**
 * Wire format of the jupyter-dag kernel-protocol additions, and the clients that speak it.
 *
 * Everything the frontend sends to or reads from the kernel is defined here: the constants and
 * message bodies, which mirror `jupyter_dag/protocol.py` (the owner of the design), and the two
 * transports that carry them. `jupyter_dag/tests/test_protocol.py` reads this file, so a string
 * constant changed here without its Python twin fails that test.
 *
 * {@link DagKernelClient} chooses between {@link ShellTransport} and {@link CommTransport} from what
 * the kernel advertises in `kernel_info_reply`, and is what the rest of the extension talks to.
 *
 * @module
 */
import { KernelMessage } from '@jupyterlab/services';
import type { Kernel, Session } from '@jupyterlab/services';
import type { ISessionContext } from '@jupyterlab/apputils';
import type { JSONObject, JSONValue } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import type { ISignal } from '@lumino/signaling';
import type { IDisposable } from '@lumino/disposable';
import type { AnalyzeChannel } from './tokens';

/** The kernelspec name; `jupyter_dag/protocol.py:KERNEL_NAME`. */
export const KERNEL_NAME = 'jupyter-dag';
/** The comm target {@link CommTransport} opens; `jupyter_dag/protocol.py:COMM_TARGET`. */
export const COMM_TARGET = 'jupyter-dag';
/** JEP 92 feature string: the kernel answers `analyze_request` on the shell and control channels. */
export const FEATURE_ANALYZE = 'cell analysis';
/** JEP 92 feature string: `execute_request` content may carry `namespace_delete`. */
export const FEATURE_NAMESPACE_DELETE = 'namespace delete';
/** JEP 92 feature string: `execute_request` content may carry `namespace_set`. */
export const FEATURE_NAMESPACE_SET = 'namespace set';
/** JEP 92 feature string: every `execute_reply` carries `namespace_delta`. */
export const FEATURE_NAMESPACE_DELTA = 'namespace delta';
/** The request message type. */
export const ANALYZE_REQUEST = 'analyze_request';
/** The reply message type. */
export const ANALYZE_REPLY = 'analyze_reply';

/** One cell to analyze, as listed under `cells` in `analyze_request` content (`AnalyzeCellInput` in Python). */
export interface IAnalyzeCellInput {
  /** The notebook cell id, echoed in the result so it can be matched to the cell. */
  cell_id: string;
  /** The cell source as the user wrote it; IPython syntax such as `%timeit` is fine. */
  code: string;
}
/** The content of an `analyze_request`, on either channel or as comm data. */
export interface IAnalyzeRequestContent {
  /** The cells to analyze; results come back in the same order. */
  cells: IAnalyzeCellInput[];
}
/**
 * Analysis result for a cell that parsed, or that was a cell magic and got no analysis.
 *
 * @remarks
 * The kernel derives the three name lists and the `dynamic` flag in `jupyter_dag/analysis.py`
 * (`analyze_source`); this is its `AnalyzedCellOk` TypedDict.
 */
export interface IAnalyzedCellOk {
  /** The id from the matching {@link IAnalyzeCellInput}. */
  cell_id: string;
  /** `'ok'` for analysed source; `'opaque'` for a `%%` cell magic, whose name lists are empty. */
  status: 'ok' | 'opaque';
  /** Global names the cell binds. Sorted. */
  defined: string[];
  /** Global names the cell reads without defining them, including builtins. Sorted. */
  referenced: string[];
  /** Names in `del` statements. Sorted. */
  deleted: string[];
  /**
   * True when the cell can change names in ways static analysis cannot see: a star import or a
   * call to any of `DYNAMIC_CALLS` in `jupyter_dag/analysis.py`.
   */
  dynamic: boolean;
}
/** Analysis result for a cell whose source did not parse (`AnalyzedCellError` in Python). */
export interface IAnalyzedCellError {
  /** The id from the matching {@link IAnalyzeCellInput}. */
  cell_id: string;
  /** Always `'error'`. */
  status: 'error';
  /** The exception class name: `SyntaxError` or a subclass such as `IndentationError`. */
  ename: string;
  /** The exception message. */
  evalue: string;
}
/** One entry of the `cells` list in `analyze_reply` content; discriminate on `status`. */
export type IAnalyzedCell = IAnalyzedCellOk | IAnalyzedCellError;
/**
 * The content of a successful `analyze_reply`.
 *
 * @remarks
 * Extends `IReplyOkContent` (`@jupyterlab/services/src/kernel/messages.ts:747`), the
 * `{ status: 'ok' }` half that every reply content in the Jupyter protocol shares.
 */
export interface IAnalyzeReplyOk extends KernelMessage.IReplyOkContent {
  /** One result per requested cell, in request order. */
  cells: IAnalyzedCell[];
}
/**
 * The content of any `analyze_reply`: ok, error or abort.
 *
 * @remarks
 * `@jupyterlab/services` spells every reply content as this three-way union but does not export
 * its `ReplyContent<T>` helper, so the union is written out here with the error and abort halves
 * from `@jupyterlab/services/src/kernel/messages.ts:756` and `:790`.
 */
export type IAnalyzeReplyContent =
  IAnalyzeReplyOk | KernelMessage.IReplyErrorContent | KernelMessage.IReplyAbortContent;
/**
 * The `namespace_delta` field of `execute_reply` content (`NamespaceDelta` in Python).
 *
 * @remarks
 * A set difference of the visible names before and after the cell ran, so a name rebound to a
 * new value appears in neither list. `DagKernel.do_execute` in `jupyter_dag/kernel/kernel.py`
 * computes it; `NamespaceDelta` in `jupyter_dag/protocol.py` shows a purge request and its reply.
 */
export interface INamespaceDelta {
  /** Visible names bound after the cell ran that were not bound before. Sorted. */
  added: string[];
  /** Visible names bound before the cell ran that are gone afterwards. Sorted. */
  removed: string[];
}
/**
 * `execute_request` content with the two jupyter-dag extensions.
 *
 * @remarks
 * ipykernel passes `do_execute` only the fields it knows, so a field added here also has to be
 * fetched from the parent message in `DagKernel.do_execute` (`jupyter_dag/kernel/kernel.py`).
 */
export type IDagExecuteRequestContent = KernelMessage.IExecuteRequestMsg['content'] & {
  /** Names to unbind before running. */
  namespace_delete?: string[];
  /** Name to JSON value, bound before running. */
  namespace_set?: JSONObject;
};
/** `execute_reply` content with the `namespace_delta` the kernel adds. */
export type IDagExecuteReplyContent = KernelMessage.IExecuteReplyMsg['content'] & {
  /** The delta the kernel added; absent on kernels without the feature. */
  namespace_delta?: INamespaceDelta;
};

/**
 * Read the `namespace_delta` off an `execute_reply`, if the reply carries one.
 *
 * @param reply - The reply message, or `undefined` for a future that resolved without one.
 * @returns The delta, or `undefined` when the reply is missing, is an error or abort reply, or
 * came from a kernel without the feature.
 */
export function readNamespaceDelta(reply: KernelMessage.IExecuteReplyMsg | undefined): INamespaceDelta | undefined {
  if (!reply || reply.content.status !== 'ok') {
    return undefined;
  }
  return (reply.content as IDagExecuteReplyContent).namespace_delta;
}

/** One way of carrying the DAG payloads to a kernel. */
export interface IDagTransport extends IDisposable {
  /**
   * Analyze cells.
   *
   * @param content - The cells to analyze.
   * @returns The successful reply content.
   * @throws Error when the kernel answers with an error or abort reply.
   */
  analyze(content: IAnalyzeRequestContent): Promise<IAnalyzeReplyOk>;
  /**
   * Unbind names in the kernel namespace without running any code.
   *
   * @param names - The names to unbind; unknown names are ignored by the kernel.
   *
   * @remarks
   * What was unbound is not returned; each transport says what it does with the kernel's answer.
   * Both send the request on the shell channel, and the kernel handles shell messages in order, so
   * an `execute_request` sent after this call runs after the purge, with one exception: a
   * {@link CommTransport} whose comm the kernel has closed reopens it first, a round trip during
   * which the `execute_request` can overtake the purge.
   */
  namespaceDelete(names: string[]): Promise<void>;
}

// KernelMessage's message-type unions are closed, so a known request type stands in for analyze_request.
type ShellStandIn = KernelMessage.IIsCompleteRequestMsg;
type ControlStandIn = KernelMessage.IDebugRequestMsg;

/**
 * `analyze_request` as a real shell (or control) message: the protocol as designed.
 *
 * @remarks
 * `@jupyterlab/services` closes its message-type unions, so `analyze_request` cannot be expressed
 * in the types; {@link ShellTransport.analyze} builds it under a stand-in type. Adding
 * `analyze_request` to those unions is the change core would need.
 *
 * Which channel. The control channel is the design's choice, because analysis needs no access to
 * the namespace and the control thread is free while a cell runs; the shell channel is the
 * default here because control messages hold ipykernel's control lock for the whole batch, so an
 * interrupt or debug request sent meanwhile waits for the analysis to finish. The
 * `analyzeChannel` setting switches between them (`IDagSettings` in `tokens.ts`).
 */
export class ShellTransport implements IDagTransport {
  /**
   * @param _kernel - The connection to send on.
   * @param _channel - `'shell'` or `'control'`.
   */
  constructor(
    private _kernel: Kernel.IKernelConnection,
    private _channel: AnalyzeChannel = 'shell'
  ) {}
  /**
   * Send one `analyze_request` and wait for its reply.
   *
   * @param content - The cells to analyze.
   * @returns The reply content once the kernel has answered and gone idle.
   * @throws Error when the reply status is `'error'` or `'abort'`.
   *
   * @remarks
   * The message is built as an existing request type of the right channel, `IIsCompleteRequestMsg`
   * (`@jupyterlab/services/src/kernel/messages.ts:1059`) or `IDebugRequestMsg` (`messages.ts:1244`),
   * with the `msgType` string overwritten; only the string reaches the wire, and the kernel
   * dispatches on it (`DagKernel.analyze_request` in `jupyter_dag/kernel/kernel.py`). A new message
   * type cannot be expressed in the types because `KernelMessage.createMessage` is overloaded once
   * per known message interface (`messages.ts:21-158`), and its generic implementation
   * (`messages.ts:162`) types `msgType` and `channel` from that interface, whose `ShellMessageType`
   * and `ControlMessageType` unions (`messages.ts:184`, `:213`) are closed.
   *
   * The message carries the connection's `subshellId` (JEP 91):
   * `Kernel.IKernelConnection.subshellId` (`@jupyterlab/services/src/kernel/kernel.ts:622`,
   * `default.ts:221`) is `null` on the main shell, and stamping it lets the kernel route the
   * request to the subshell this connection belongs to, as every core request does.
   *
   * `sendShellMessage(msg, expectReply, disposeOnDone)`
   * (`@jupyterlab/services/src/kernel/default.ts:359`) and `sendControlMessage`
   * (`default.ts:390`) return a future. With `expectReply` true, the future's `done` promise
   * (`@jupyterlab/services/src/kernel/future.ts:56`) resolves with the reply message once both the
   * reply (`future.ts:241-244`) and the `idle` status on iopub (`future.ts:267-270`) have arrived;
   * `disposeOnDone` true then disposes the future (`future.ts:274-283`); nothing else holds it. A
   * kernel that never replies would leave the promise pending, so the kernel side sends a reply
   * even when analysis raises.
   */
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
  /**
   * Purge without running: a silent `execute_request` of empty code carrying `namespace_delete`.
   *
   * @param names - The names to unbind.
   *
   * @remarks
   * `requestExecute` (`@jupyterlab/services/src/kernel/default.ts:789`) is the same call every cell
   * run makes; the content type has to be widened by hand because `@jupyterlab/services` types it
   * as the stock `execute_request` content. The purge's own `execute_reply` carries the
   * `namespace_delta` of what it unbound.
   */
  async namespaceDelete(names: string[]): Promise<void> {
    const content: IDagExecuteRequestContent = {
      code: '',
      silent: true,
      store_history: false,
      namespace_delete: names
    };
    await this._kernel.requestExecute(content as unknown as KernelMessage.IExecuteRequestMsg['content'], true).done;
  }
  /** Whether {@link ShellTransport.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /** Mark the transport disposed; it holds nothing that needs releasing. */
  dispose(): void {
    this._isDisposed = true;
  }
  private _isDisposed = false;
}

interface ICommPayload {
  type: string;
  supported_features?: string[];
}

/**
 * The no-protocol-change prototype: the same payloads over the `jupyter-dag` comm target.
 *
 * @remarks
 * Works against any kernel that has registered the `jupyter-dag` comm target, which
 * `%load_ext jupyter_dag` does. The comm is opened lazily on the first request and afresh after the
 * kernel has closed it; a kernel without the target is reported by {@link CommTransport.open}
 * rather than by a request that never answers.
 *
 * How a request gets its reply. `comm.send(data)`
 * (`@jupyterlab/services/src/kernel/comm.ts:196-219`) sends a `comm_msg` with `expectReply` false,
 * so no shell reply is waited for. The kernel handler sends its reply with `comm.send` while still
 * handling the request, and ipykernel stamps that outgoing `comm_msg` with the request as its
 * parent (see the module docstring of `jupyter_dag/kernel/comm.py`). The request future's
 * `onIOPub` (`@jupyterlab/services/src/kernel/future.ts:86`) receives every iopub message whose
 * parent is the request, so the reply arrives there, ahead of the `idle` status that resolves
 * `done`. No request ids are needed.
 */
export class CommTransport implements IDagTransport {
  /**
   * @param _kernel - The connection to open the comm on.
   *
   * @remarks
   * The kernel-initiated direction is registered but still a stub: `registerCommTarget`
   * (`@jupyterlab/services/src/kernel/default.ts:1084`) is the kernel opening a comm towards the
   * frontend, delivered through `_handleCommOpen` (`default.ts:1350-1382`) to the callback.
   * Registering it now is preparation for a kernel that pushes without being asked.
   */
  constructor(private _kernel: Kernel.IKernelConnection) {
    // TODO: kernel-initiated comms (the kernel opening `jupyter-dag` towards the frontend, e.g. right
    // after `%load_ext jupyter_dag`), so the kernel can push without the frontend opening a comm first.
    _kernel.registerCommTarget(COMM_TARGET, this._onKernelInitiated);
  }
  private _onKernelInitiated = (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg): void => {
    void msg.content.target_name;
    void comm; // TODO: adopt it as this._comm and attach onMsg / onClose exactly as open() does
  };
  /**
   * The feature strings the kernel sent on comm open; empty until {@link CommTransport.open} has run.
   *
   * @remarks
   * A stock kernel that loaded the extension with `%load_ext` answered `kernel_info_request` before
   * the extension existed, so the frontend's cached `supported_features` say nothing about it. The
   * kernel side sends `{ type: 'features', supported_features: [...] }` on every comm open instead,
   * with the same strings a jupyter-dag kernel puts in `kernel_info_reply`.
   */
  get features(): ReadonlySet<string> {
    return this._features;
  }
  /**
   * Open the comm and wait until the kernel has accepted it.
   *
   * @returns The open comm, also kept as the transport's current comm.
   * @throws Error when comms are disabled on the connection (`handleComms`,
   * `@jupyterlab/services/src/kernel/kernel.ts:112`) or the kernel has no `jupyter-dag` target.
   *
   * @remarks
   * `createComm(targetName)` (`@jupyterlab/services/src/kernel/default.ts:1038`) makes a
   * `CommHandler` with a fresh id; `comm.open()` (`@jupyterlab/services/src/kernel/comm.ts:163-186`)
   * sends `comm_open` naming the target, as a shell message that does not expect a reply. The
   * kernel's `CommManager` looks the target up and calls the registered callback,
   * `DagCommTarget._on_open` in `jupyter_dag/kernel/comm.py`; a kernel that has no such target
   * answers with `comm_close`, which `_handleCommClose` (`default.ts:1385-1403`) turns into
   * disposing the handler, so `isDisposed` after `open().done` means "no target". Every later
   * `comm_msg` from the kernel with this comm id reaches `_handleCommMsg` (`default.ts:1407-1419`),
   * which calls the `onMsg` callback (`comm.ts:151`).
   *
   * A `CommHandler` the kernel has closed cannot be reopened, so every call creates a new one; the
   * `onClose` callback (`comm.ts:131`) drops the reference and the next request opens again.
   */
  async open(): Promise<Kernel.IComm> {
    const kernel = this._kernel;
    if (!kernel.handleComms) {
      throw new Error('comms are disabled on this kernel connection');
    }
    const comm = kernel.createComm(COMM_TARGET); // a fresh comm id each time: reuse after reconnect throws
    comm.onMsg = (msg: KernelMessage.ICommMsgMsg) => {
      const data = msg.content.data as unknown as ICommPayload;
      if (data.type === 'features') {
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
  /**
   * Send an `analyze_request` payload over the comm and wait for the reply.
   *
   * @param content - The cells to analyze.
   * @returns The reply content the kernel sent on the comm.
   * @throws Error when no reply arrived before the request went idle, or the reply status is not
   * `'ok'`.
   *
   * @remarks
   * The reply is picked out of the request future's iopub stream by message type
   * (`isCommMsgMsg`, `@jupyterlab/services/src/kernel/messages.ts:736`) and comm id, then read
   * after `done` resolves, which is safe because the kernel sends the reply while still handling
   * the request, ahead of the `idle` status that resolves `done`.
   */
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
  /**
   * Send a `namespace_delete` payload over the comm.
   *
   * @param names - The names to unbind.
   *
   * @remarks
   * The comm reply (`{ removed: [...] }`, `DagCommTarget._namespace_delete` in
   * `jupyter_dag/kernel/comm.py`) is discarded. A comm purge produces no `execute_reply`, so what it
   * unbound appears in no `namespace_delta` either.
   */
  async namespaceDelete(names: string[]): Promise<void> {
    const comm = this._comm ?? (await this.open());
    await comm.send({ type: 'namespace_delete', names } as unknown as JSONValue).done;
  }
  /** Whether {@link CommTransport.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /**
   * Close the comm (sending `comm_close`, `@jupyterlab/services/src/kernel/comm.ts:232`) and drop
   * the target registration (`default.ts:1108`).
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._kernel.removeCommTarget(COMM_TARGET, this._onKernelInitiated);
    this._comm?.close();
    this._comm?.dispose();
  }
  private _comm: Kernel.IComm | null = null;
  private _features = new Set<string>();
  private _isDisposed = false;
}

/**
 * Per-session client: feature detection from `kernel_info`, one transport, and the
 * `namespace_delta` stream.
 *
 * @remarks
 * Lifetime. A client is bound to one `ISessionContext`, which outlives any particular kernel: the
 * session context re-emits the kernel connection's signals and swaps the connection on kernel
 * change (`@jupyterlab/apputils/src/sessioncontext.tsx:91`, `:111`). The client follows those
 * signals and rebuilds its transport each time.
 *
 * Feature detection. `kernel.info` (`@jupyterlab/services/src/kernel/kernel.ts:90`,
 * `default.ts:258`) is a promise resolved by the connection's first `kernel_info_reply`
 * (`default.ts:644-684`), so its `supported_features` are what the kernel advertised when the
 * connection was made (JEP 92). A kernel that advertises {@link FEATURE_ANALYZE} gets a
 * {@link ShellTransport}; any other kernel is probed with a {@link CommTransport}.
 * {@link DagKernelClient.featuresChanged} announces each result.
 *
 * Why restart is handled through two signals. A user restart goes through
 * `SessionContext.restartKernel` (`@jupyterlab/apputils/src/sessioncontext.tsx:755-775`), which
 * emits `'restarting'` on `statusChanged`, awaits the restart, then emits `kernelChanged` with the
 * same connection. An automatic restart after a kernel death only produces `'autorestarting'` and
 * later `'idle'` statuses from the connection (`@jupyterlab/services/src/kernel/default.ts:1269`)
 * and never a `kernelChanged`. Watching both covers both; the generation counter in
 * {@link DagKernelClient.detectFeatures} makes the double trigger of a user restart harmless.
 *
 * Where `namespace_delta` is read. The kernel attaches it to every `execute_reply`, whoever sent
 * the request (`DagKernel.do_execute` in `jupyter_dag/kernel/kernel.py`), and `anyMessage`
 * (`@jupyterlab/services/src/kernel/kernel.ts:575`, `default.ts:179`) fires for every message the
 * connection sends or receives. One listener on it, filtered to received `execute_reply` messages,
 * therefore sees the deltas of cells run from the notebook panel, from the DAG view and from
 * purges alike.
 */
export class DagKernelClient implements IDisposable {
  /**
   * @param sessionContext - The session whose kernels this client follows.
   * @param analyzeChannel - The channel {@link ShellTransport} sends `analyze_request` on.
   *
   * @remarks
   * Detection is not started here: a kernel already running when the client is made sends no
   * `kernelChanged`, so the owner calls {@link DagKernelClient.detectFeatures} once itself
   * (`DagPanel` in `document.tsx` does).
   */
  constructor(sessionContext: ISessionContext, analyzeChannel: AnalyzeChannel = 'shell') {
    this._sessionContext = sessionContext;
    this._analyzeChannel = analyzeChannel;
    sessionContext.kernelChanged.connect(this._onKernelChanged, this);
    sessionContext.statusChanged.connect(this._onStatusChanged, this);
    this.kernel?.anyMessage.connect(this._onAnyMessage, this);
  }
  /** The session's current kernel connection, if the session has one. */
  get kernel(): Kernel.IKernelConnection | null | undefined {
    return this._sessionContext.session?.kernel;
  }
  /**
   * The jupyter-dag feature strings the current kernel supports.
   *
   * @remarks
   * From `kernel_info_reply`, plus whatever the comm's `features` message added when the transport
   * is a {@link CommTransport}. Empty when there is no kernel or detection has not finished.
   */
  get features(): ReadonlySet<string> {
    return this._features;
  }
  /** Emitted with the delta of every `execute_reply` the current kernel connection receives. */
  get namespaceDelta(): ISignal<this, INamespaceDelta> {
    return this._namespaceDelta;
  }
  /**
   * Emitted after every detection: kernel start, change or restart, and explicit
   * {@link DagKernelClient.detectFeatures} calls; the argument is the new feature set.
   */
  get featuresChanged(): ISignal<this, ReadonlySet<string>> {
    return this._featuresChanged;
  }
  /**
   * Query the current kernel's features and build the matching transport.
   *
   * @remarks
   * The transport is dropped first, so callers never see a transport for a kernel that is gone.
   * Detection awaits twice (`kernel.info`, then a possible comm open), and a kernel change or
   * restart can start another detection in between; the generation counter makes the older run
   * dispose whatever it opened and return without emitting, so only the newest result is installed
   * and announced. With no kernel the result is an empty feature set, still announced, so listeners
   * can clear stale state.
   */
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
    }
    this._featuresChanged.emit(this._features);
  }
  /**
   * Per-cell defined/referenced names, or nothing when the kernel offers no analysis.
   *
   * @param cells - The cells to analyze.
   * @returns One result per cell, or an empty list when there is no transport.
   */
  async analyze(cells: IAnalyzeCellInput[]): Promise<IAnalyzedCell[]> {
    return this._transport ? (await this._transport.analyze({ cells })).cells : [];
  }
  /**
   * Unbind names in the kernel, if it supports that; a no-op without a transport.
   *
   * @param names - The names to unbind.
   */
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
  private _onKernelChanged(
    _: ISessionContext,
    { oldValue, newValue }: Session.ISessionConnection.IKernelChangedArgs
  ): void {
    oldValue?.anyMessage.disconnect(this._onAnyMessage, this);
    newValue?.anyMessage.connect(this._onAnyMessage, this);
    void this.detectFeatures();
  }
  private _onAnyMessage(_: unknown, { msg, direction }: Kernel.IAnyMessageArgs): void {
    if (direction === 'recv' && KernelMessage.isExecuteReplyMsg(msg)) {
      const delta = readNamespaceDelta(msg);
      if (delta) {
        this._namespaceDelta.emit(delta);
      }
    }
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
  /** Whether {@link DagKernelClient.dispose} has been called. */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  /**
   * Dispose the transport and disconnect from the session context and kernel.
   *
   * @remarks
   * `Signal.clearData(this)` removes every connection made with `connect(..., this)`, including the
   * `anyMessage` one that moves to each new kernel connection.
   */
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
