# The kernel: IRkernel's `Kernel` reference class plus the jupyter-dag additions.
#
# `IRkernel` dispatches shell messages with a `switch` inside `Kernel$handle_shell`, so there is no
# handler table to add to; the subclass reimplements `handle_shell` and `handle_control` with
# `analyze_request` added and `execute_request` routed through `execute`, which applies the
# namespace operations around `Executor$execute`. The executor sends `execute_reply` through the
# kernel's `send_response`, which is overridden to attach `namespace_delta`; `kernel_info` is
# overridden to advertise the features.
#
# Why the class is built in `.onLoad` rather than at the top level: a reference-class method runs
# with the object's environment as its enclosure, and that environment's parent is the environment
# the class was defined in. Inherited methods therefore look their free names up in the subclass's
# home, so `Kernel`'s own methods would not find `IRkernel`'s internals (`fromJSON`, `namedlist`,
# `PROTOCOL_VER`, the `pbdZMQ` functions) from a class defined in this namespace. The class is
# defined in an environment whose parent is `IRkernel`'s namespace and which holds a copy of this
# package's functions, so both sides resolve.

#' Holds the generator built by `.onLoad()`.
#' @keywords internal
the <- new.env(parent = emptyenv())

#' Methods of the `DagKernel` reference class.
#' @keywords internal
dag_kernel_methods <- list(
  initialize = function(...) {
    "Set up IRkernel's kernel, then register the comm target."
    callSuper(...)
    before_names <<- NULL
    register_dag_comm(comm_manager)
  },
  kernel_info = function(request) {
    "IRkernel's reply with `supported_features` added."
    rversion <- paste0(version$major, ".", version$minor)
    send_response("kernel_info_reply", request, "shell", list(
      protocol_version = PROTOCOL_VER,
      implementation = "IRdag",
      implementation_version = as.character(utils::packageVersion("IRdag")),
      language_info = list(
        name = "R", codemirror_mode = "r", pygments_lexer = "r",
        mimetype = "text/x-r-source", file_extension = ".r", version = rversion
      ),
      banner = version$version.string,
      supported_features = json_array(ALL_FEATURES)
    ))
  },
  handle_shell = function() {
    "IRkernel's shell dispatch with `analyze_request` added and `execute_request` wrapped."
    parts <- zmq.recv.multipart(sockets$shell, unserialize = FALSE)
    msg <- wire_to_msg(parts)
    send_response("status", msg, "iopub", list(execution_state = "busy"))
    switch(msg$header$msg_type,
      analyze_request = analyze(msg, "shell"),
      execute_request = execute(msg),
      comm_info_request = comm_manager$on_comm_info_request(msg),
      comm_open = comm_manager$on_comm_open(msg),
      comm_msg = comm_manager$on_comm_msg(msg),
      comm_close = comm_manager$on_comm_close(msg),
      kernel_info_request = kernel_info(msg),
      history_request = history(msg),
      complete_request = complete(msg),
      is_complete_request = is_complete(msg),
      inspect_request = inspect(msg),
      shutdown_request = shutdown(msg),
      log_debug(c("Got unhandled msg_type:", msg$header$msg_type))
    )
    send_response("status", msg, "iopub", list(execution_state = "idle"))
  },
  handle_control = function() {
    "IRkernel's control dispatch with `analyze_request` added, bracketed by busy and idle."
    parts <- zmq.recv.multipart(sockets$control, unserialize = FALSE)
    msg <- wire_to_msg(parts)
    if (msg$header$msg_type == "shutdown_request") {
      shutdown(msg)
    } else if (msg$header$msg_type == "analyze_request") {
      send_response("status", msg, "iopub", list(execution_state = "busy"))
      analyze(msg, "control")
      send_response("status", msg, "iopub", list(execution_state = "idle"))
    } else {
      log_debug(paste("Unhandled control message, msg_type:", msg$header$msg_type))
    }
  },
  analyze = function(request, socket_name) {
    "Answer `analyze_request` with `analyze_reply` on the channel it came in on, even on failure."
    reply <- tryCatch(
      list(status = "ok", cells = analyze_cells(request$content$cells)),
      error = function(cond) error_content(cond)
    )
    send_response(ANALYZE_REPLY, request, socket_name, reply)
  },
  execute = function(request) {
    "Snapshot the visible names, apply `namespace_delete` and `namespace_set`, then run the cell."
    content <- request$content
    before_names <<- visible_names()
    delete_names(content$namespace_delete)
    set_names(content$namespace_set)
    executor$execute(request)
    before_names <<- NULL
  },
  send_response = function(msg_type, parent_msg, socket_name, content) {
    "Attach `namespace_delta` to the `execute_reply` of a cell started by `execute`."
    if (identical(msg_type, "execute_reply") && !is.null(before_names)) {
      content$namespace_delta <- compute_delta(before_names, visible_names())
    }
    callSuper(msg_type, parent_msg, socket_name, content)
  }
)

#' Build the `DagKernel` class, a subclass of `IRkernel`'s `Kernel`.
#'
#' @param libname,pkgname As passed by `loadNamespace`.
#' @keywords internal
.onLoad <- function(libname, pkgname) {
  ns <- asNamespace(pkgname)
  home <- new.env(parent = asNamespace("IRkernel"))
  for (name in ls(ns)) {
    assign(name, get(name, envir = ns), envir = home)
  }
  the$DagKernel <- methods::setRefClass(
    "DagKernel",
    contains = "Kernel",
    fields = list(before_names = "ANY"),
    methods = dag_kernel_methods,
    where = home
  )
  invisible()
}

#' Start the kernel; the entry point the kernelspec runs.
#'
#' @param connection_file Path to the connection file; by default the first argument after
#'   `--args` on the command line, as `IRkernel::main()` reads it.
#' @export
main <- function(connection_file = "") {
  if (connection_file == "") {
    connection_file <- commandArgs(TRUE)[[1L]]
  }
  log_debug("Starting the jupyter-dag R kernel...")
  kernel <- the$DagKernel$new(connection_file = connection_file)
  kernel$run()
}

utils::globalVariables(c(
  "PROTOCOL_VER", "zmq.recv.multipart", "sockets", "executor", "comm_manager", "before_names",
  "callSuper", "send_response", "wire_to_msg", "analyze", "execute", "kernel_info", "history",
  "complete", "is_complete", "inspect", "shutdown"
))
