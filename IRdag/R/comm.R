# The no-protocol-change transport: the `jupyter-dag` comm target carrying the analyze and
# namespace payloads.
#
# `IRkernel`'s `CommManager` calls a target's handler with the new comm and the open data, and each
# later `comm_msg` reaches whatever `comm$on_msg()` registered. A reply sent with `comm$send()` from
# inside the handler goes out on iopub with the request as its parent (`CommManager$send_msg` uses
# the message being handled), so the frontend's future for the request receives it and no request
# ids are needed.

#' Register the `jupyter-dag` comm target on the kernel's comm manager.
#'
#' On open the kernel sends `{"type": "features", "supported_features": [...]}`, which is how a
#' frontend that cached an older `kernel_info_reply` learns what the kernel can do.
#'
#' @param comm_manager The kernel's `CommManager`.
#' @keywords internal
register_dag_comm <- function(comm_manager) {
  comm_manager$register_target(COMM_TARGET, function(comm, data) {
    comm$on_msg(function(request) comm$send(handle_comm_request(request)))
    comm$send(list(type = "features", supported_features = json_array(ALL_FEATURES)))
  })
}

#' Answer one comm request by its `type`.
#'
#' @param request The `data` of the `comm_msg`: `type` plus `cells`, `names` or `values`.
#' @return `{"status": "ok", ...}` with the handler's fields, or `error_content()` of whatever
#'   went wrong, including an unknown `type`.
#' @keywords internal
handle_comm_request <- function(request) {
  tryCatch(
    {
      type <- request$type
      if (is.null(type)) {
        type <- ""
      }
      result <- switch(type,
        analyze_request = list(cells = analyze_cells(request$cells)),
        namespace_delete = list(removed = json_array(delete_names(request$names))),
        namespace_set = list(set = json_array(set_names(request$values))),
        stop("unknown request type: ", type)
      )
      c(list(status = "ok"), result)
    },
    error = function(cond) error_content(cond)
  )
}
