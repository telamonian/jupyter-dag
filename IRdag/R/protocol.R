# Wire format of the jupyter-dag kernel-protocol additions, as the R kernel speaks it.
#
# Every constant here has a twin in the Python kernel (`jupyter_dag/protocol.py`) and the frontend
# (`src/dag/protocol.ts`); `tests/testthat/test-protocol.R` reads the TypeScript file to check they
# match. The payload shapes are the same as the Python kernel's, so one frontend serves both.

#' @importFrom jsonlite fromJSON toJSON
NULL

#' Name of the kernelspec `installspec()` writes.
#' @keywords internal
KERNEL_NAME <- "jupyter-dag-r"

#' Display name of the kernelspec.
#' @keywords internal
DISPLAY_NAME <- "R (jupyter-dag)"

#' The comm target the frontend opens when the kernel does not advertise the message types.
#' @keywords internal
COMM_TARGET <- "jupyter-dag"

#' JEP 92 feature strings the kernel lists under `supported_features` in `kernel_info_reply`.
#'
#' Spelled like ipykernel's own ("kernel subshells", "debugger"): lower case, space separated.
#' @keywords internal
FEATURE_ANALYZE <- "cell analysis"
#' @rdname FEATURE_ANALYZE
#' @keywords internal
FEATURE_NAMESPACE_DELETE <- "namespace delete"
#' @rdname FEATURE_ANALYZE
#' @keywords internal
FEATURE_NAMESPACE_SET <- "namespace set"
#' @rdname FEATURE_ANALYZE
#' @keywords internal
FEATURE_NAMESPACE_DELTA <- "namespace delta"
#' @rdname FEATURE_ANALYZE
#' @keywords internal
ALL_FEATURES <- c(FEATURE_ANALYZE, FEATURE_NAMESPACE_DELETE, FEATURE_NAMESPACE_SET, FEATURE_NAMESPACE_DELTA)

#' Message types of the analysis request and its reply, on the shell and control channels.
#' @keywords internal
ANALYZE_REQUEST <- "analyze_request"
#' @rdname ANALYZE_REQUEST
#' @keywords internal
ANALYZE_REPLY <- "analyze_reply"

#' Make a character vector serialise as a JSON array even when it has one element.
#'
#' `IRkernel` serialises every message with `jsonlite::toJSON(auto_unbox = TRUE)`, which turns a
#' length-one vector into a scalar. A list of strings always becomes an array, and an empty one
#' becomes `[]`.
#'
#' @param x A character vector.
#' @return An unnamed list with one string per element.
#' @keywords internal
json_array <- function(x) {
  as.list(as.character(x))
}

#' Sort names the way the Python kernel does: unique, by code point, not by the session locale.
#'
#' @param x A character vector.
#' @return The sorted unique names.
#' @keywords internal
sorted <- function(x) {
  sort(unique(as.character(x)), method = "radix")
}

#' Build the error form of a reply, spelled like an `execute_reply` error.
#'
#' @param cond The condition that stopped the handler.
#' @return A list with `status` `"error"`, `ename` (the condition's first class), `evalue` (its
#'   message) and an empty `traceback`. The frontend only checks `status`.
#' @keywords internal
error_content <- function(cond) {
  list(status = "error", ename = class(cond)[[1L]], evalue = conditionMessage(cond), traceback = list())
}
