# Static analysis of cell source: which global names a cell defines, references and deletes.
#
# This answers `analyze_request` and the comm request of the same name. Nothing here reads the
# global environment. The one side effect is that a `library()` or `require()` call makes the
# analysis load that package's namespace (not attach it) to list its exports, which the cell would
# do anyway when it runs.
#
# R has no `symtable`, so the work is split: `codetools::findGlobals` resolves scopes for the
# names a cell reads (the whole cell is wrapped in a function, so top-level assignments become
# locals and a name both read and bound counts as defined only, as in the Python kernel), and a
# walk over the parse tree finds what the cell binds, unbinds and does dynamically. Builtins stay
# in `referenced`; whoever turns results into wires only draws one for a name another cell defines.

#' @importFrom codetools findGlobals
NULL

#' Calls that can bind or read names static analysis cannot see; any of them sets `dynamic`.
#'
#' `assign`, `rm`, `library` and `require` are handled statically when their arguments are
#' literals and set `dynamic` only otherwise, so they are not listed here.
#' @keywords internal
DYNAMIC_CALLS <- c(
  "eval", "evalq", "eval.parent", "source", "sys.source", "load", "attach", "detach",
  "get", "get0", "mget", "exists", "do.call", "match.fun", "ls", "objects",
  "globalenv", "environment", "as.environment", "parent.frame", "sys.function"
)

#' Calls whose code argument is evaluated in an environment of its own, so assignments inside it
#' do not reach the global environment.
#' @keywords internal
SCOPED_CALLS <- c("local", "with", "within")

#' Words `codetools` reports as functions or variables that are syntax, not names.
#' @keywords internal
RESERVED_WORDS <- c(
  "if", "else", "repeat", "while", "function", "for", "next", "break", "in",
  "TRUE", "FALSE", "NULL", "Inf", "NaN", "NA", "NA_integer_", "NA_real_", "NA_character_", "NA_complex_"
)

#' Keep the strings that are syntactic names, dropping operators such as `+`, `[<-` and `{`.
#'
#' @param x A character vector.
#' @return The subset that is a syntactic name and not a reserved word.
#' @keywords internal
syntactic_names <- function(x) {
  x[grepl("^[A-Za-z.][A-Za-z0-9._]*$", x) & !grepl("^\\.[0-9]", x) & !(x %in% RESERVED_WORDS)]
}

#' The name a call is a call to, seeing through `pkg::name` and `pkg:::name`.
#'
#' @param e A call.
#' @return The name as a string, or `NA` when the function position is an expression such as
#'   `(function(x) x)(1)`.
#' @keywords internal
call_name <- function(e) {
  fn <- e[[1L]]
  if (is.symbol(fn)) {
    return(as.character(fn))
  }
  if (is.call(fn) && length(fn) == 3L && is.symbol(fn[[1L]]) && as.character(fn[[1L]]) %in% c("::", ":::") && is.symbol(fn[[3L]])) {
    return(as.character(fn[[3L]]))
  }
  NA_character_
}

#' The variable a replacement assignment such as `names(x)[i] <- v` modifies.
#'
#' @param lhs The left-hand side of the assignment, a call.
#' @return The innermost name as a string, or `NULL` when it is not a name.
#' @keywords internal
target_symbol <- function(lhs) {
  while (is.call(lhs)) {
    if (length(lhs) < 2L) {
      return(NULL)
    }
    lhs <- lhs[[2L]]
  }
  if (is.symbol(lhs)) {
    return(as.character(lhs))
  }
  if (is.character(lhs) && length(lhs) == 1L) {
    return(lhs)
  }
  NULL
}

#' Whether an `envir` argument names the global environment literally.
#'
#' @param expr The argument expression, or `NULL`.
#' @return `TRUE` for `.GlobalEnv` and `globalenv()`.
#' @keywords internal
is_global_env_literal <- function(expr) {
  identical(expr, quote(.GlobalEnv)) || identical(expr, quote(globalenv()))
}

#' A fresh accumulator for one cell's walk.
#'
#' @return An environment with `defined`, `mutated` and `deleted` (character vectors) and
#'   `dynamic` (a flag).
#' @keywords internal
new_collector <- function() {
  acc <- new.env(parent = emptyenv())
  acc$defined <- character()
  acc$mutated <- character()
  acc$deleted <- character()
  acc$dynamic <- FALSE
  acc
}

#' Walk one expression of a cell, recording what it binds, unbinds and does dynamically.
#'
#' `top` is `TRUE` while the walk is at the cell's level, where `<-` binds a global, and `FALSE`
#' inside function bodies and the scoped calls, where it binds a local. `<<-` and `assign()` or
#' `rm()` with `envir = .GlobalEnv` reach the global environment from any depth. The elements of a
#' call are visited by index because a missing argument (`x[1, ]`) or a formal without a default
#' is the empty symbol, which cannot be bound to a loop variable.
#'
#' @param e A language object: call, pairlist of formals, symbol or constant.
#' @param top Whether `e` is evaluated at the cell's level.
#' @param acc The collector from `new_collector()`.
#' @return Nothing; `acc` is updated.
#' @keywords internal
collect <- function(e, top, acc) {
  if (is.pairlist(e)) {
    for (i in seq_along(e)) {
      collect(e[[i]], FALSE, acc)
    }
    return(invisible())
  }
  if (!is.call(e)) {
    return(invisible())
  }
  name <- call_name(e)
  if (is.na(name)) {
    for (i in seq_along(e)) {
      collect(e[[i]], top, acc)
    }
    return(invisible())
  }
  switch(name,
    "function" = {
      collect(e[[2L]], FALSE, acc)
      collect(e[[3L]], FALSE, acc)
    },
    "<-" = ,
    "=" = collect_assignment(e, top, acc, global = top),
    "<<-" = collect_assignment(e, top, acc, global = TRUE),
    "for" = {
      if (top && is.symbol(e[[2L]])) {
        acc$defined <- c(acc$defined, as.character(e[[2L]]))
      }
      collect(e[[3L]], top, acc)
      collect(e[[4L]], top, acc)
    },
    "assign" = collect_assign_call(e, top, acc),
    "rm" = ,
    "remove" = collect_rm_call(e, top, acc),
    "library" = ,
    "require" = collect_library_call(e, acc),
    {
      if (name %in% DYNAMIC_CALLS) {
        acc$dynamic <- TRUE
      }
      inner <- if (name %in% SCOPED_CALLS) FALSE else top
      for (i in seq_along(e)[-1L]) {
        collect(e[[i]], inner, acc)
      }
    }
  )
  invisible()
}

#' Record an assignment: a name on the left is defined, a replacement target is mutated.
#'
#' A mutated name (`x[1] <- v`, `names(x) <- v`) is reported as referenced, not defined, as the
#' Python kernel reports `d[k] = v`: the cell depends on whoever bound `x`.
#'
#' @param e The `<-`, `=` or `<<-` call.
#' @param top Passed on to the walk of the right-hand side.
#' @param acc The collector.
#' @param global Whether the assignment reaches the global environment.
#' @keywords internal
collect_assignment <- function(e, top, acc, global) {
  if (length(e) != 3L) {
    return(invisible())
  }
  lhs <- e[[2L]]
  if (is.symbol(lhs) || (is.character(lhs) && length(lhs) == 1L)) {
    if (global) {
      acc$defined <- c(acc$defined, as.character(lhs))
    }
  } else if (is.call(lhs)) {
    target <- target_symbol(lhs)
    if (!is.null(target) && global) {
      acc$mutated <- c(acc$mutated, target)
    }
    collect(lhs, top, acc)
  }
  collect(e[[3L]], top, acc)
  invisible()
}

#' Record an `assign()` call: a literal name is defined, anything else is dynamic.
#'
#' @param e The call.
#' @param top Whether the call is at the cell's level.
#' @param acc The collector.
#' @keywords internal
collect_assign_call <- function(e, top, acc) {
  m <- tryCatch(match.call(base::assign, e), error = function(cond) NULL)
  if (is.null(m)) {
    acc$dynamic <- TRUE
    return(invisible())
  }
  global <- top || is_global_env_literal(m$envir)
  if (is.character(m$x) && length(m$x) == 1L) {
    if (global) {
      acc$defined <- c(acc$defined, m$x)
    }
  } else {
    acc$dynamic <- TRUE
  }
  for (arg in setdiff(names(m)[-1L], c("x", "envir", "pos"))) {
    collect(m[[arg]], top, acc)
  }
  invisible()
}

#' Record an `rm()` or `remove()` call: literal names are deleted, anything else is dynamic.
#'
#' @param e The call.
#' @param top Whether the call is at the cell's level.
#' @param acc The collector.
#' @keywords internal
collect_rm_call <- function(e, top, acc) {
  m <- tryCatch(match.call(base::rm, e), error = function(cond) NULL)
  if (is.null(m)) {
    acc$dynamic <- TRUE
    return(invisible())
  }
  global <- top || is_global_env_literal(m$envir)
  names <- character()
  arg_names <- names(m)
  if (is.null(arg_names)) {
    arg_names <- rep("", length(m))
  }
  for (i in seq_along(m)[-1L]) {
    arg <- m[[i]]
    if (arg_names[[i]] == "") {
      if (is.symbol(arg) || (is.character(arg) && length(arg) == 1L)) {
        names <- c(names, as.character(arg))
      } else {
        acc$dynamic <- TRUE
      }
    } else if (arg_names[[i]] == "list") {
      literal <- literal_strings(arg)
      if (is.null(literal)) {
        acc$dynamic <- TRUE
      } else {
        names <- c(names, literal)
      }
    }
  }
  if (global) {
    acc$deleted <- c(acc$deleted, names)
  }
  invisible()
}

#' The strings of a literal character vector expression: `"a"` or `c("a", "b")`.
#'
#' @param expr The expression.
#' @return The strings, or `NULL` when the expression is anything else.
#' @keywords internal
literal_strings <- function(expr) {
  if (is.character(expr)) {
    return(expr)
  }
  if (is.call(expr) && identical(expr[[1L]], as.name("c"))) {
    parts <- as.list(expr)[-1L]
    if (all(vapply(parts, is.character, logical(1L)))) {
      return(as.character(unlist(parts)))
    }
  }
  NULL
}

#' Record a `library()` or `require()` call as defining the names the package attaches.
#'
#' A notebook cell that calls `filter()` after another cell's `library(dplyr)` depends on that
#' cell, so the attach is reported as defining the package's exports (and those of the packages in
#' its `Depends`). A package that cannot be loaded, or a package named by a variable, makes the
#' cell dynamic instead.
#'
#' @param e The call.
#' @param acc The collector.
#' @keywords internal
collect_library_call <- function(e, acc) {
  definition <- if (identical(call_name(e), "require")) base::require else base::library
  m <- tryCatch(match.call(definition, e), error = function(cond) NULL)
  pkg <- m$package
  if (is.null(m) || is.null(pkg)) {
    return(invisible())
  }
  name <- if (is.character(pkg) && length(pkg) == 1L) {
    pkg
  } else if (is.symbol(pkg) && !isTRUE(m$character.only)) {
    as.character(pkg)
  } else {
    NULL
  }
  exports <- if (is.null(name)) NULL else tryCatch(attached_exports(name), error = function(cond) NULL)
  if (is.null(exports)) {
    acc$dynamic <- TRUE
  } else {
    acc$defined <- c(acc$defined, exports)
  }
  invisible()
}

#' Memo of `attached_exports()`, keyed by package, for the life of the kernel.
#' @keywords internal
exports_cache <- new.env(parent = emptyenv())

#' The names `library(pkg)` puts on the search path: its exports plus those of its `Depends`.
#'
#' Loads the namespace if it is not loaded yet, without attaching it.
#'
#' @param pkg The package name.
#' @param seen Packages already visited, to stop on dependency cycles.
#' @return The names, unique.
#' @keywords internal
attached_exports <- function(pkg, seen = character()) {
  if (pkg %in% seen) {
    return(character())
  }
  cached <- exports_cache[[pkg]]
  if (!is.null(cached)) {
    return(cached)
  }
  exports <- getNamespaceExports(pkg)
  depends <- suppressWarnings(utils::packageDescription(pkg, fields = "Depends"))
  if (is.character(depends) && !is.na(depends)) {
    for (dep in dependency_names(depends)) {
      exports <- c(exports, attached_exports(dep, c(seen, pkg)))
    }
  }
  exports <- unique(exports)
  exports_cache[[pkg]] <- exports
  exports
}

#' Package names in a `Depends` field, versions stripped and `R` dropped.
#'
#' @param field The field text, such as `"R (>= 3.5), ggplot2 (>= 3.0)"`.
#' @return The package names.
#' @keywords internal
dependency_names <- function(field) {
  parts <- trimws(sub("\\s*\\(.*\\)\\s*$", "", strsplit(field, ",")[[1L]]))
  parts[nzchar(parts) & parts != "R"]
}

#' The free names of a cell, by `codetools`, with the cell wrapped in a function.
#'
#' @param exprs The parsed expressions.
#' @return The syntactic names the wrapper reads without binding.
#' @keywords internal
free_names <- function(exprs) {
  wrapper <- function() NULL
  body(wrapper) <- as.call(c(as.name("{"), as.list(exprs)))
  globals <- tryCatch(findGlobals(wrapper, merge = TRUE), error = function(cond) unlist(lapply(exprs, all.names)))
  syntactic_names(unique(as.character(globals)))
}

#' Analyze parsed source.
#'
#' At the cell's level an assignment defines its name, a `for` binds its variable, and a `<<-` or
#' `assign()` with a literal name defines from any depth; a name both read and bound is only
#' defined. Replacement targets are referenced. `rm()` with literal names deletes, and a deleted
#' name is neither defined nor referenced. A `library()` defines the attached exports. Whatever
#' the walk cannot see statically sets `dynamic`.
#'
#' @param cell_id Echoed into the result.
#' @param exprs The parsed expressions of the cell.
#' @return A list with `cell_id`, `status` `"ok"`, the sorted `defined`, `referenced` and
#'   `deleted` arrays, and `dynamic`.
#' @keywords internal
analyze_exprs <- function(cell_id, exprs) {
  acc <- new_collector()
  for (e in as.list(exprs)) {
    collect(e, TRUE, acc)
  }
  defined <- setdiff(acc$defined, acc$deleted)
  referenced <- setdiff(c(free_names(exprs), acc$mutated), c(defined, acc$deleted))
  list(
    cell_id = cell_id,
    status = "ok",
    defined = json_array(sorted(defined)),
    referenced = json_array(sorted(referenced)),
    deleted = json_array(sorted(acc$deleted)),
    dynamic = acc$dynamic
  )
}

#' Analyze one cell as the user wrote it; never raises.
#'
#' @param cell_id Echoed into the result.
#' @param code The cell source.
#' @return The `analyze_exprs()` result, or for source that does not parse a list with `status`
#'   `"error"`, `ename` `"ParseError"` and the parser's message as `evalue`.
#' @keywords internal
analyze_cell <- function(cell_id, code) {
  exprs <- tryCatch(parse(text = code, keep.source = FALSE, encoding = "UTF-8"), error = function(cond) cond)
  if (inherits(exprs, "condition")) {
    return(list(cell_id = cell_id, status = "error", ename = "ParseError", evalue = conditionMessage(exprs)))
  }
  analyze_exprs(cell_id, exprs)
}

#' The `cells` of a request as a list of `cell_id` and `code` pairs.
#'
#' `jsonlite::fromJSON` turns an array of uniform objects into a data frame, and an empty array into
#' an empty list; a comm payload or a test may hand over a list of lists.
#'
#' @param cells The decoded `cells` field.
#' @return An unnamed list of lists with `cell_id` and `code`.
#' @keywords internal
as_cell_inputs <- function(cells) {
  if (is.data.frame(cells)) {
    if (!all(c("cell_id", "code") %in% names(cells))) {
      stop("each cell needs a cell_id and code")
    }
    return(lapply(seq_len(nrow(cells)), function(i) list(cell_id = cells$cell_id[[i]], code = cells$code[[i]])))
  }
  lapply(as.list(cells), function(cell) {
    if (is.null(cell$cell_id) || is.null(cell$code)) {
      stop("each cell needs a cell_id and code")
    }
    list(cell_id = cell$cell_id, code = cell$code)
  })
}

#' Analyze a batch of cells, one result per input in the same order.
#'
#' @param cells The `cells` field of an `analyze_request` or comm request.
#' @return An unnamed list of per-cell results; a cell that fails to parse gets an error entry.
#' @keywords internal
analyze_cells <- function(cells) {
  lapply(as_cell_inputs(cells), function(cell) analyze_cell(cell$cell_id, cell$code))
}
