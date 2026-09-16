# Two kernel-protocol designs for jupyter-dag, compared

September 14, 2026. This compares the protocol design in `kernel-design-notes.md`
sections 2 and 3 (below, "the notes' design") with the simplification I proposed the
same day (below, "the simplified design"; full text in
`protocol-design-simplified.md`).

How this was produced. Five independent analyses looked at both designs from fixed
angles: kernel implementer, plugin author, JEP reviewer, per-language matrix, and a
steelman of each side against the other. Twelve verifiers then tried to refute 23
load-bearing claims from the simplified design, each claim checked twice, once from
primary sources (ipykernel 7.3.0, IPython 9.17.1, jupyter_client 8.10, JupyterLab
4.7.0a1, the messaging spec, JEPs 47, 80, 91, 92, with live experiments against the
venv kernel) and once from the ecosystem (Pluto, marimo, Hex, Observable, papermill,
Kishu, ipyflow, xeus, IRkernel, IJulia, Deno, bash_kernel, JShell). A final pass
looked for gaps and contradictions. Of 46 verdicts, 45 were "holds with caveats" and
one was "refuted". Nothing held cleanly. The caveats are the content of this
document.

## 1. The two designs in one table

| | notes' design | simplified design |
|---|---|---|
| Edge analysis | `analyze_request` on the control channel; per cell: defines, references, imports, confidence, has_unknown_references | `analyze_request` on the shell channel, batch of code strings; per cell: status, defines, references, one `dynamic` flag; imports folded into defines |
| Delete names | standalone `namespace_request {delete: [...]}` on shell | `namespace_delete: [...]` on `execute_request`, applied before the code runs; purge without running = empty code with `silent` |
| Set names from JSON | `namespace_request {set: {name: value}}` | none; inputs arrive via comms or generated assignment code |
| Read values | `user_expressions` | `user_expressions` |
| Runtime delta | `execute_reply.namespace_delta {added, rebound, removed}` | `execute_reply.namespace_delta {added, removed}`, present whenever the kernel advertises it |
| Branch isolation | `create_scope`, `drop_scope`, `execute_request.scope`; child is a shallow copy of or chain onto the parent | none in the kernel; the frontend enforces one definition per name; isolation comes from a server-level clone |
| Snapshots | `snapshot`, `restore`, list, delete on shell, plus a CRIU provisioner tier and replay | nothing in the kernel protocol; CRIU provisioner and replay behind a server "clone kernel" operation |
| Channels touched | shell and control | shell only, subshells for responsiveness |
| New message pairs | 4, plus 4 for snapshots | 1 |
| New fields on existing messages | 2 | 2 |
| Feature strings | one per feature, never named | 3, never named |
| Edge meaning | "B runs after A in one namespace"; value edges deferred | same |

## 2. What the two designs share

Both designs put the same work in the frontend: topological order, cycle detection,
staleness, conflict detection, a per-cell ledger of the names defined at the last
run, gating on feature strings, and fallback analysis providers for kernels without
the feature. Both reuse `stop_on_error`, `silent`, `cellId`, comms, and JEP 92
`supported_features`. Both defer value-carrying edges. Both plan to prototype over a
comm target in ipykernel, which means a comm target carries either design unchanged:
the footprint question decides what the pre-proposal says, not what can be built
before October 19.

Both also make the same mistakes, listed in section 6.

## 3. Item by item

### 3.1 Scopes: kept by the notes, dropped by the simplification

What the notes wanted. A `create_scope(parent)` primitive, a `scope` field on
`execute_request`, and `drop_scope`, so a DAG can run a shared prefix once and fork
branches that rebind the same names. The notes describe the child as a shallow dict
copy or a lookup chain, claim isolation "as long as cells rebind rather than mutate",
say scopes compose with subshells for concurrent branches, and cite Pluto's workspace
modules as the Julia version.

What the review found about the notes' version, all reproduced in the venv:

- A lookup chain cannot be Python globals. `exec()` rejects a `ChainMap`, and the
  language docs disclaim dict subclasses as globals.
- A bare dict copy assigned as `user_ns` breaks closures over cell-level names; a
  Python scope has to be a fresh module object swapped into `shell.user_module` and
  `shell.user_ns` around each execute.
- Isolation is weaker than "rebind, don't mutate". Functions defined before the fork
  keep `__globals__` bound to the parent dict, so a child's rebinding is invisible
  to upstream code and later parent rebinds leak into the child. That is a rebinding
  leak, which the notes said scopes were safe against. Pluto avoids it only by
  re-running every dependent cell in the new module.
- Scopes do not compose with subshells as written. `InteractiveShell` has one
  `user_ns` shared by every subshell thread; per-request namespaces under concurrency
  need a context-local namespace inside IPython, not an ipykernel change.
- `%who`, the debugger's variable views, `copyToGlobals`, and `user_expressions` all
  read the one shell namespace and would each need a scope parameter.
- Pluto never forks workspaces. Each `workspace#N` replaces the last in a linear
  chain. Pluto is precedent for delete by module migration, not for branch isolation.

What the simplified design gives up. This is the largest divergence for the DAG
plugin. Under the one-definition rule, two branches that both end in `model = fit(...)`
are a conflict: the user renames, the plugin refuses, or the plugin serializes the
branches and the losing branch's readers go stale. In-process parameter sweeps over
one subgraph become sequential or need one kernel per value. JavaScript kernels lose
their only route to "no hidden state", since a fresh context was the only way to make
a `let` or `const` binding disappear. The precedent I cited is narrower than I said:
marimo, Pluto, and Observable enforce one definer per name; no Hex document states
such a rule, and Hex ships a fallback that runs cells in notebook order when it
cannot infer dependencies, which suggests Hex tolerates duplicates.

What the simplified design keeps right. Scopes never delivered isolation beyond the
namespace level. Process-global state such as RNGs, `pd.set_option`, the current
matplotlib figure, `os.chdir`, and shared iterators leaks through a shallow copy
exactly as it does through one namespace. Every shipped reactive notebook runs on one
namespace. And scopes are the one item that would be reviewed the way subshells were:
they change how every kernel executes code.

Verdict. The cut is sound for the reactive plugin and for a proposal that has to
land. It is a real loss for the DAG plugin, and the review agrees it reduces to one
product decision: may two branches of a user-drawn DAG define the same name? See
section 8.

### 3.2 Snapshots and clone: four messages in the notes, none in the simplification

Both designs agree that replay needs nothing from the kernel and that CRIU belongs
in a jupyter_client provisioner. The review changed the reasons on both sides.

- Restore in place needs no protocol change, provided the provisioner uses
  `--tcp-close`, keeps jupyter_client's restarter from replacing the kernel during
  the dump-and-restore gap (it polls `provisioner.poll()` every 3 seconds), keeps the
  restored process's parent pid stable (ipykernel's parent poller exits within a
  second if it changes), and routes the restore through the existing restart path so
  JupyterLab clears futures and comms and ipywidgets re-syncs via `comm_info`.
- Clone by "restore one image twice" does not exist on a plain host. CRIU restores
  the original pid and the original bound ports; a second copy needs its own pid and
  network namespace, meaning containers, or kernel-side rebind code. The notes'
  phrase "kernel rebinds ZMQ ports" describes a mechanism ipykernel does not have;
  ports bind once at startup with no retry when a port is specified. On a plain
  install the only clone is replay.
- The language-native tier does not require new messages either. Kishu implements
  checkpoint and checkout with IPython `pre_run_cell` and `post_run_cell` hooks plus
  silent `execute_request` with `user_expressions`. Messages buy a language-neutral,
  advertised contract with fidelity reporting. That is the notes' argument for them,
  and it is the correct framing; "only this tier needs messages" was mine and it is
  wrong.
- The Kishu figures hold verbatim: CRIU-Incremental was up to 36 times slower on
  checkout for the largest notebook, comparable on checkpoint, faster on 3 of 8
  notebooks, and failed on 2 of 8.

Verdict. Removing the four message pairs from the kernel protocol is right and costs
kernel authors nothing. The consequence for the DAG plugin is that the "isolation
tier below" is replay in practice, which is a full prefix re-run per branch. That
raises the price of dropping scopes; it does not reverse it.

### 3.3 Delete: a standalone message in the notes, a field on execute_request in the simplification

Verified mechanics of the field, against ipykernel 7.3.0:

- An `execute_request` with empty code and `silent: true` does not increment the
  execution counter, publishes no `execute_input`, stores no history, still
  publishes busy and idle, still evaluates `user_expressions`, and replies `ok`. Empty
  code without `silent` is broken: kernelbase publishes an `execute_input` with a
  counter IPython never consumes and the next cell repeats the prompt number. Silent
  is mandatory, not a nicety.
- JupyterLab's `CodeCell.execute` refuses empty code, so purges must call
  `kernel.requestExecute` directly.
- No forced signature change. kernelbase already inspects `do_execute` for
  `cell_meta` and `cell_id` and passes them only to implementations that accept
  them; `namespace_delete` slots into the same list, and bash_kernel's five-argument
  `do_execute` keeps working. IPythonKernel could also apply the delete in its own
  `do_execute` with no kernelbase change.
- Delete-then-rerun is one message and atomic with respect to other clients on the
  same subshell. A reactive rerun of N cells is N messages instead of 2N.

Where the two shapes differ in behavior:

- Failure on a kernel without the feature. The field is silently ignored (verified:
  `x` survived) and the cell runs against stale bindings with an `ok` reply. The
  notes' unknown `namespace_request` gets no reply at all in ipykernel, so the
  frontend future hangs. A hang is an availability failure a timeout detects; a
  skipped delete is a correctness failure nothing detects. Both need feature gating;
  under a gating bug the message fails safe and the field fails unsafe. The fix
  stays inside the simplified shape: advertise the delete string only when
  `do_execute` accepts the parameter, and echo what was removed under
  `namespace_delta.removed` so the frontend can verify.
- Abort. `dispatch_shell` aborts only `execute_request` after a `stop_on_error`
  failure, so a queued silent purge is aborted with the rest of the queue. That is
  right for "delete before rerun" purges and wrong for "cell removed" purges. A
  queued `namespace_request` is never aborted, which is the reverse.
- Delete before run or on success. The field fixes delete-before-run: a cell that
  fails to compile or run has already lost its previous bindings, which is marimo's
  semantics and needs the scheduler to record "undefined because the run failed".
  The message leaves the choice to the frontend.
- Reversibility. Shell placement for analysis is the reversible channel choice, but
  on this axis the message is the reversible shape: a message can later gain a
  convenience field, while a field cannot be retired in favor of a message without
  leaving two ways to do one thing.
- Neither shape says what happens to names that cannot be removed (`__builtins__`,
  `In`, `Out`, JS `let`, R locked bindings, Julia consts). The notes'
  `namespace_reply` had room for a per-name report and did not use it; `execute_reply`
  has no slot at all.

Verdict. The field is the cheaper and tighter shape for the reactive plugin's common
path. Its two costs, silent failure and the abort asymmetry, are both closable
without a new message. The choice is Max's; my recommendation is the field with the
two mitigations and a `not_deleted` list on the reply.

### 3.4 Set: kept by the notes, dropped by the simplification

This is where one of my claims was refuted. I wrote that a kernel-side `set` is
"only needed if we later choose value-carrying edges". The notes listed three uses
that have nothing to do with value edges: widget-bound variables, papermill-style
parameters, and DAG input ports. Dropping `set` does not remove those needs; it moves
them. Without it, an input cell or parameter on a kernel without a widget library
either becomes generated assignment source, which is papermill's translator layer
living in the frontend, or does not exist.

What held: JSON-to-binding is ambiguous in R, JavaScript, and Julia, and the two
reactive notebooks that bind JSON values to names both shipped kernel-side conversion
hooks for exactly that reason (Pluto's `transform_value`, marimo's `_convert_value`).
What did not hold as stated: papermill's translators exist because it injects a
source cell and needs each language's literal and assignment syntax; they hard-code
one choice per language and do not resolve the numeric ambiguity, and papermill has
no JavaScript translator at all, so it was the wrong witness. "Comms already carry
widget-bound values" is also narrower than it sounds: comms deliver a value to a
trait on a kernel-side widget object, not to a name, and only on kernels with a
widget library. Neither design covers the Pluto shape, a bound global name driven by
a slider, without frontend bookkeeping from widget id to defining cell to name.

Verdict. Dropping `set` is a relocation, not a saving. It is still the right call for
a first version whose thesis is reactive execution, because the spec burden of a
per-language coercion table is real and the ambiguity argument undercuts the notes'
"costs nothing extra" too. The decision is where the mapping lives, and it should be
stated that way.

### 3.5 The runtime delta: added, rebound, removed against added, removed

What held: added and removed are cheap (under 3 ms on a 100,000-name namespace) and,
after filtering, exact in Python and R. Rebound by object identity has both problems
I named: ids are recycled after deallocation (reproduced: `x = None; x = [9,9,9]`
reports no rebind), and holding the pre-run dict keeps every replaced object alive
until the reply, so `df = transform(df)` peaks at old plus new.

What the review added:

- "Exact set difference" is exact only relative to a per-language enumeration the
  spec has to define. In ipykernel a raw key diff after one run reports `_1`, `_i`,
  `_i1`, `_ii`, `_iii`; the `user_ns_hidden` identity filter that `%who` uses is
  required. In R, `library()` changes the search path, not `globalenv`. In Julia,
  `using` is invisible to `names(Main)` before 1.12, and removed is always empty. In
  JavaScript, `let` and `const` are not properties of `globalThis`; the correct
  enumeration is the CDP call `Runtime.globalLexicalScopeNames`. In bash,
  `PIPESTATUS`, `_`, `RANDOM`, and `SECONDS` change on their own.
- Subshells share one namespace, so a before-and-after diff on one subshell
  attributes another subshell's assignments to this cell, and `set(user_ns)` can
  raise if the dict changes size mid-iteration. Neither design mentions it.
- The field must be present on `status: error` replies, since a failing cell can bind
  names before raising; ipykernel's natural slot next to `user_expressions` is
  skipped on error.
- Neither design says whether removed includes names removed by the same request's
  pre-run delete.
- The dichotomy for rebound is not exhaustive. A weakref-where-possible hybrid bounds
  the memory cost for heavy objects, and instrumentation, which is what ipyflow
  actually does, detects rebinding exactly at CPU cost. Dropping rebound is a choice,
  not a necessity.
- Dropping rebound blinds the two uses I gave the field. Validation: cell A defines
  `x`, cell B runs `exec("x = 2")`; B's delta is empty because `x` already exists,
  and only rebound would show B writing a name owned by A. Parser-less kernels: after
  the first run, `count=$((count+1))` produces an empty delta, so "the defines half of
  an edge for free" on bash is only first definitions, and bash_kernel would need two
  extra pexpect round trips per cell to get even that.
- The notes' "ipyflow proves it works" is wrong in the other direction. ipyflow
  instruments execution with pyccolo and tracing; it does not diff namespaces.

Verdict. The shrink is defensible and additive, since rebound can return as an
optional key. The claims around it should be cut back: the field validates static
analysis for new names only, and bash gets first definitions, not defines.

### 3.6 Where analysis runs: control in the notes, shell in the simplification

The notes put `analyze_request` on control "like debug_request" to avoid queuing
behind a busy shell. I moved it to shell for three reasons: same dispatch path as
`complete` and `inspect`, no threading requirement on kernel authors, and ordering
with executions. The review left the conclusion standing and weakened two of the
three reasons.

- Norms. JEP 91's motivation names completion, introspection, and variable inspection
  as things people put on control because it had its own thread, and says "this is
  considered bad practice as it should only be used for control purposes". Reviewers
  will quote it against the notes' placement. The spec itself does not reserve
  control: it calls the channel "identical to Shell" on a separate socket, allows
  `kernel_info` there since 5.5, and ipykernel accepts every shell message type on
  control. So the notes' placement was against guidance, not against the spec.
- Who is responsive today. A control thread exists in ipykernel and in xeus-python
  (split server). It does not exist in xeus-cpp or xeus-r (default single-thread
  server), IRkernel (one `zmq.poll` loop), or in practice IJulia (two cooperative
  tasks on one thread). Subshells exist in ipykernel 7 only; neither xeus nor
  xeus-zmq mentions them through their latest releases. On today's kernels the
  notes' control route is responsive on a strict superset of the kernels the
  simplified design's subshell route is. The simplified design wins on direction and
  on what it asks of kernel authors, not on present capability.
- Ordering. My IPython example was weak. `%%foo` and `%foo` rewrite textually whether
  or not the magic is registered; only single-line automagic (which also depends on
  `user_ns` shadowing) and runtime-registered input transformers depend on live
  state. The ordering requirement is real and strong elsewhere: Pluto expands macros
  in the live workspace module before resolving the topology, and a C++ cell cannot
  be parsed without the accumulated translation unit. So shell ordering is the right
  choice for Julia and C++, credited for the wrong language.
- Ordering and responsiveness are mutually exclusive per request. A request sent to a
  subshell is ordered only within that subshell. The frontend picks per call: main
  shell when it needs post-execution parse state, a subshell when it needs an answer
  during a long run. The design should say so.
- Thread safety does not discriminate. The multi-line static path is pure tokenizer
  work. The single-line path enters `builtin_trap`, whose nesting counter is an
  unsynchronized read-modify-write shared with the executing thread, and runs the
  prefilter, which can trigger `%load_ext`. The hazard is identical for the control
  thread and a subshell thread, and ipykernel already runs `transform_cell` on
  subshell threads today. The right fix under either design is to call the static
  `input_transformer_manager.transform_cell()` and skip the prefilter.
- Failure. An unknown message type on either channel gets no reply in ipykernel, and a
  message sent to a stale `subshell_id` is dropped with only a log line, so the
  frontend hangs rather than receiving the error JEP 91 promises.
- Reversibility. Shell first is the reversible direction; `shutdown_request`'s move
  from shell to control took a deprecation cycle, and JEP 80 shows a message can
  later be allowed on both channels.

Verdict. Shell, for the norms and the reversal path, with an explicit per-call policy
and the honest statement that responsive analysis is ipykernel-only for now.

### 3.7 The shape of the analysis reply

Neither design gave a schema before; mine did, and the review found schema problems in
it and information losses relative to the notes.

- `code` as a list conflicts with every other request, where `code` is a string. A
  spec maintainer would reject the reuse of the name with a different type.
- Folding imports into defines is right for Python, JavaScript, and C++ and wrong
  for R and Julia: `library(dplyr)` and `using Foo` bind nothing enumerable at top
  level yet must be ancestors of every cell that uses an exported name. Pluto keeps
  `using` statements as a separate class for this reason. A drawn-graph UI also wants
  to hide import edges and not flag two branches that both `import numpy as np`. The
  notes' separate `imports` list was load-bearing.
- One `dynamic` flag forces the frontend to treat "may define names I cannot see" and
  "may reference names I cannot see" identically. The notes' `has_unknown_references`
  kept the distinction; a star-import cell and an NSE-heavy R cell should schedule
  differently.
- The per-cell error entry is the right shape; a syntax error must not fail the batch.
- Neither design defines `references`: free variables only, or all names read;
  whether reads inside function bodies count (marimo and Observable count them);
  whether `obj.attr = 1` is a reference; whether `x += 1` is both.
- Both designs' "transform_cell then ast or symtable" undercounts the analyzer.
  `transform_cell` turns every cell-magic body into a string literal, so `%%time`
  bodies must be re-parsed from the `run_cell_magic` argument, `%%capture out`
  defines `out`, and `%%R -i x -o y` needs per-magic argument parsing with no
  registry API to declare it. `$var` in `!` and line magics is expanded at run time.
  `symtable` has no top-level-await flag, so the analyzer must wrap the cell in an
  async scope. `del x` shows as an assignment. Measured cost is 2.5 ms per 200-line
  cell, so batching a whole notebook is fine.

### 3.8 Advertising and footprint

JEP 92 explicitly allows a feature to be "additional messages and/or additional fields
in different existing messages", so gating fields on strings is conformant, and
JupyterLab already parses the list. Three strings for one message and two fields is a
worse ratio than JEP 91 or the debugger, and a reviewer will accept it only if each
string has a testable contract: delete must specify per-name failure reporting; delta
must specify the name filter and the concurrency caveat; analysis must specify the
references semantics. Neither design names its strings or versions them, and JEP 91
itself says a version specifier is probably needed.

On cost, the review's strongest point: cost scales with semantics kernel authors must
implement, not with message count. JEP 92, one optional field, went from proposal to
merge in five months. JEP 91, new threading semantics, took 21 months to merge, 34 to
a shipped ipykernel 7.0, and has no xeus implementation yet. Scopes are in the JEP 91
class; `analyze_request` and `namespace_delete` are in the JEP 92 class. The
simplified design's real saving is removing the one JEP 91 class item, not shaving
message pairs.

## 4. What each plugin can do under each design

| Behavior | notes' design | simplified design |
|---|---|---|
| Graph of a cold notebook before anything runs | one batch analyze; needs a running kernel | same |
| Rewire on edit without running | analyze on control, live during a long run on ipykernel and xeus-python | analyze on shell; live during a long run on ipykernel via a subshell; queued elsewhere |
| Stale markers | frontend | frontend |
| Rerun descendants with partial failure | `stop_on_error` is coarser than needed under both; scheduler blocks descendants of an errored ancestor itself | same; plus delete-before-run means a failed cell has no bindings |
| No hidden state on delete or rename | separate message; frontend may delete only after success | field; delete happens before the run |
| Two branches defining `model` | run both, each in its own scope, concurrently on subshells (needs an IPython change to be real) | refuse, rename, serialize, or clone a kernel by replay |
| Parameter sweep over one subgraph | N scopes, N sets, results collected per scope | sequential in one namespace with generated assignment code, or N kernels |
| Input ports and parameters from the UI | one `set` message; kernel owns the JSON mapping | comms on kernels with a widget library; generated source elsewhere; translators live in the plugin |
| Read a value out | `user_expressions`, plus a scope id | `user_expressions` |
| Concurrent independent branches | scopes on subshells | subshells with proven-disjoint defines; GIL limits it to I/O-bound cells |
| Kernels without analysis (bash, cling) | manual edges; delta including rebound | manual edges; delta reports first definitions only |
| Reconcile analysis with what ran | delta with rebound catches dynamic writes to existing names | delta catches new names only |
| Julia | delete via module bump under either | same; my "Julia can advertise analysis without delete" framed a choice as a limit |

For the reactive plugin alone, the simplified design is sufficient and simpler. For
the DAG plugin, it covers fan-out over disjoint names and defers genuine branching to
a tier outside the kernel that is replay on a plain install.

## 5. Per-language feasibility

| Language and kernel | analysis | delete | delta | scopes (notes) | set (notes) |
|---|---|---|---|---|---|
| Python, ipykernel | yes, with magic handling and a dynamic flag | yes; must decide whether `Out` and `_` are scrubbed | yes, with the hidden-name filter | fresh module per scope; concurrency needs an IPython change | exact |
| R, IRkernel | yes; NSE makes many cells dynamic | `rm` from globalenv; `library()` not undoable by `rm` | yes if it also diffs the search path | `new.env(parent=)`, the cleanest substrate | ambiguous: integer vs double, vector vs list vs data frame |
| Julia, IJulia | yes; macros must expand in the live module, so order matters | only by Pluto-style module bump plus method-table surgery | added only; `using` invisible before 1.12 | modules, but Pluto never forked them | ambiguous: Int64 vs Float64, Dict vs NamedTuple |
| JavaScript, Deno and ijavascript | yes for Deno (swc in-kernel) | no: `let` and `const` cannot be removed; Deno allows redeclaration only | needs `Runtime.globalLexicalScopeNames` | `vm.createContext`; the only route to delete | number precision, BigInt |
| bash | no | `unset` | `compgen -v` diff, noisy, two extra round trips | none | strings only |
| C++, xeus-cpp | yes, order-dependent on the accumulated TU | no; clang-repl undo is LIFO and not exposed | new declarations per input | none | none |
| SQL | dialect-specific; SQLite's authorizer is exact | `DROP`, which destroys data | catalog diff; not cheap on warehouses, not isolated from other sessions | none | none |
| JVM, JShell | defines only | `drop(snippet)`, with dependents re-marked | eval events, exact | none | typed |

Delete is exact in five of eight; set is exact in one. Factoring delete out of the
notes' namespace-ops bundle is the single biggest agnosticism gain in the simplified
design. Delta is more universally implementable than analysis, but it never yields
references and it must be normatively defined per language or two kernels
advertising the same string will disagree.

## 6. What both designs got wrong

- "user_expressions already covers get." IRkernel returns an empty list, bash_kernel
  and metakernel return `{}`, xeus-cpp ignores the argument. Get exists on ipykernel,
  xeus-python, and IJulia.
- Neither says what delete scrubs. A plain `del user_ns[name]` leaves the object
  reachable through `Out[n]`, `_`, and `_N`, so a cell reading `_` sees stale data.
- Neither defines the delta's name set, its presence on error replies, its relation
  to the same request's delete, or its behavior under concurrent subshells.
- Both treat `stop_on_error` as the partial-failure semantics a topological run
  needs. It aborts everything queued on the same subshell, so it over-aborts
  independent siblings when the scheduler pre-queues and does nothing when cells are
  sent one at a time.
- Both underestimate the analyzer (section 3.7) and gesture at cell magics
  declaring their inputs and outputs without a mechanism.
- Both misstate why snapshots would need messages: contract, not capability.
- Both under-specify clone: the notes' "kernel rebinds ports" does not exist; my
  "a REST change" hides the namespace requirement; neither mentions the restarter
  race or the parent poller.
- Both misuse Pluto in opposite directions: the notes as precedent for forkable
  scopes, which Pluto never had; my design as "only for delete", when Pluto's delete
  is a module bump plus method deletion plus re-imports, which a name list cannot
  express.
- Both cite ipyflow for namespace diffing; it traces.
- Both leave the feature strings unnamed and unversioned, and both are silent on what
  a kernel that advertises delete does when a name cannot be removed.
- Both assume analysis is order-free enough to run out of order somewhere. For IPython
  automagic, Julia macros, and C++ it is not, and neither tells the frontend to
  re-analyze after execution.
- Both describe `set` as the emulation route to value-carrying edges. Real value edges
  need kernel-side handles for arbitrary objects; a JSON `set` emulates only
  JSON-representable values.

## 7. Gaps neither design covers

- The ordinary execution path. Run Cell and Run All from the notebook view must go
  through the plugin or the ledger diverges from the kernel at once. JupyterLab 4
  exposes a replaceable `INotebookCellExecutor` token and only one provider can hold
  it. Under the simplified design the replacement executor adds one field to the
  request it already sends; under the notes' design it sequences two futures.
- Multiple clients on one kernel. A console, a second tab, or a collaborator runs
  `x = 5` outside the ledger. Neither design has a kernel-side owner of "which cell
  defined this name". The ledger has to live in cell metadata in the shared model to
  be RTC-safe.
- Ledger persistence: reload, kernel restart, and opening a notebook whose kernel is
  still running all need a reconciliation story; the actual namespace is recoverable
  only by probing.
- Temporaries under the one-definition rule. Ordinary Jupyter code reuses `i`, `df`,
  `fig`, `ax`, `tmp` in many cells. marimo mangles underscore-prefixed names to
  cell-local names in the kernel; neither design has a way to express cell-private
  names. This will be the first complaint from any user of the reactive plugin.
- The semantics of `references` (section 3.7) and the policy for `dynamic` cells:
  run last, treat as defining everything downstream, refuse in reactive mode as
  marimo does for star imports, or warn. The value of dropping rebound depends on
  this policy.
- Interrupt during a cascade: the scheduler must reconcile ran, aborted before run,
  and, under the notes' message shape only, "deleted but never ran".
- Which second kernel proves agnosticism. xeus-python drives an IPython
  `InteractiveShell`, so it shares the analyzer, the delete, the name filter, and the
  threading story with ipykernel and proves almost nothing. Deno, IRkernel, or IJulia
  each exercise a divergence the review found.
- Effort accounting. My table counts protocol items. The simplified design moves
  work to the frontend: per-language literal generation for parameters, conflict
  refusal or serialization, clone orchestration against an endpoint that does not
  exist. The notes' design moves work the other way: scope lifecycle, re-forking
  children when the prefix reruns, a scope id on every read.

## 8. Decisions, with my recommendation

1. May two branches of a user-drawn DAG define the same name? This is the decision
   the whole scopes debate reduces to, and it is about the DAG plugin, not the
   reactive one. Recommendation: no, for the first version. Enforce one definition per
   name, flag conflicts from analysis, and offer clone-by-replay for real branching
   later. If the answer is yes, the notes' scopes come back with a fresh-module
   implementation and an IPython change for concurrency.
2. Which plugin first. Recommendation: reactive. Its surface is analysis, delete, and
   delta, and every shipped reactive notebook runs on that surface.
3. Channel for analysis. Recommendation: shell, with a stated per-call policy: main
   shell when ordering matters, a subshell when the kernel has them and the user is
   waiting.
4. Delete as a field or a message. Recommendation: the field, with the delete string
   advertised only when `do_execute` accepts the parameter, removed names echoed in
   the delta, and a `not_deleted` list on the reply.
5. Delete before run or on success. Recommendation: before run, marimo's semantics,
   with the scheduler recording names undefined because the run failed.
6. Rebound. Recommendation: leave it out of the first version and reserve it as an
   optional key; state plainly that the delta validates new names only.
7. Set. Recommendation: leave it out, and say that inputs are authored as code cells
   or ipywidgets in the first version, so the loss is named rather than hidden.
8. Imports. Recommendation: put the `imports` list back as an optional key carrying
   module names. It is load-bearing for R and Julia and cheap.
9. One uncertainty flag or two. Recommendation: two, `unknown_defines` and
   `unknown_references`.
10. Feature strings. Recommendation: three, named, each with a testable contract
    written before ipykernel ships them.
11. The batch field. Recommendation: do not reuse `code` for a list; use a
    differently named field.
12. What to build before October 19 versus what to propose. Recommendation: build the
    simplified surface over a comm target, and let the pre-proposal name scopes and
    set as deferred with the reasons above, so the talk shows the small surface.
13. Second kernel. Recommendation: IRkernel or Deno rather than xeus-python; either
    exercises a real divergence (no `user_expressions` and invisible `library()` in
    R; no delete for `let` in JavaScript).

## 9. Conclusion

The simplified design is the one to propose, for a reason stronger than its message
count: it removes the only item that would be reviewed like subshells, and that item
was unsound as written. Its two irreversible commitments, shell channel and delete as
a field, are the ones with the cheaper reversal paths or the closable failure modes.
Every other cut is additive later.

The notes' design remains the more complete statement of what the DAG plugin was
started for. Same-name branches, in-process sweeps, and language-agnostic input ports
are real capabilities the simplified design gives up, and the "server tier below" I
pointed at is replay on any plain install. That trade is a product decision, and it
should be made explicitly rather than inherited from a protocol footprint argument.

Several of my stated reasons were wrong even where the conclusion stands, and they
should not appear in a proposal: the Hex precedent, the IPython magic example for
ordering, "no threading requirement", "for free" on bash, "only needed for value
edges", the papermill attribution, `copyToGlobals` as session-free, and
`deletedCells` as a kernel-side precedent.
