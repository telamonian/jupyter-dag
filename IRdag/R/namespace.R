# Namespace operations on the global environment, behind `namespace_delete`, `namespace_set` and
# `namespace_delta`.
#
# IRkernel evaluates every cell in `.GlobalEnv` (`Executor$execute` calls
# `evaluate(code, envir = .GlobalEnv)`), and keeps its own helpers on an attached environment
# named `jupyter:irkernel` rather than in the global one, so the user-visible names are exactly the
# bindings of `.GlobalEnv`. Names starting with a dot are hidden, as `ls()` hides them and as the
# Python kernel hides names starting with an underscore.

#' The user-visible global names: the bindings of the global environment, dot names excluded.
#'
#' @param env The environment to list; the global environment in the kernel.
#' @return The names, sorted by code point.
#' @keywords internal
visible_names <- function(env = globalenv()) {
  sorted(ls(env))
}

#' Unbind names from the global environment; the `namespace_delete` operation.
#'
#' @param names Names to unbind; unknown names are ignored, as is anything that is not a string.
#' @param env The environment to unbind from.
#' @return The names that were bound and got unbound, in input order.
#' @keywords internal
delete_names <- function(names, env = globalenv()) {
  names <- as.character(unlist(names))
  present <- names[vapply(names, exists, logical(1L), envir = env, inherits = FALSE)]
  rm(list = present, envir = env)
  present
}

#' Bind decoded JSON values as global names; the `namespace_set` operation.
#'
#' The values arrive as `jsonlite::fromJSON` decodes them with its default simplification: a JSON
#' number is a length-one numeric, an array of numbers a vector, an array of arrays a matrix, and an
#' object a named list.
#'
#' @param values A named list of name to value.
#' @param env The environment to bind in.
#' @return The names bound, sorted.
#' @keywords internal
set_names <- function(values, env = globalenv()) {
  names <- names(values)
  for (name in names) {
    assign(name, values[[name]], envir = env)
  }
  sorted(names)
}

#' The `namespace_delta` of two snapshots of `visible_names()`: a set difference.
#'
#' A name rebound to a new value appears in neither list; staleness from rebinding is the
#' frontend's job, through the analysis results.
#'
#' @param before The visible names before the cell ran.
#' @param after The visible names after it ran.
#' @return A list with `added` and `removed`, both sorted JSON arrays.
#' @keywords internal
compute_delta <- function(before, after) {
  list(added = json_array(sorted(setdiff(after, before))), removed = json_array(sorted(setdiff(before, after))))
}
