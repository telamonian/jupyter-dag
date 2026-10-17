#' Install the `jupyter-dag-r` kernelspec where Jupyter will find it.
#'
#' Mirrors `IRkernel::installspec()`: the shipped `kernel.json` gets this R's binary as `argv[1]`,
#' the logos are copied from `IRkernel`, and `jupyter kernelspec install --replace` does the
#' install. An `R_LIBS` entry in the spec's `env` lets the kernel load this package from a library
#' outside R's default paths, such as one inside a project environment.
#'
#' @param user Install into the per-user kernels directory. The default unless `prefix` or
#'   `sys_prefix` is given.
#' @param name The kernelspec name.
#' @param displayname The name shown in kernel pickers.
#' @param prefix Install under `<prefix>/share/jupyter/kernels` instead.
#' @param sys_prefix Install into the `sys.prefix` of the `jupyter` on the path, such as the
#'   environment it lives in.
#' @param lib A library path to put in the spec's `R_LIBS`, or `NULL` for none.
#' @param verbose Show `jupyter`'s output.
#' @return The exit status of `jupyter kernelspec install`, invisibly.
#' @export
installspec <- function(user = NULL, name = KERNEL_NAME, displayname = DISPLAY_NAME, prefix = NULL,
                        sys_prefix = FALSE, lib = NULL, verbose = getOption("verbose")) {
  exit_code <- system2("jupyter", c("kernelspec", "--version"), FALSE, FALSE)
  if (exit_code != 0) {
    stop("jupyter-client has to be installed but ", dQuote("jupyter kernelspec --version"), " exited with code ", exit_code)
  }
  if (is.null(user)) {
    user <- is.null(prefix) && !sys_prefix
  }
  if (sum(user, !is.null(prefix), sys_prefix) > 1) {
    stop("\"user\", \"prefix\" and \"sys_prefix\" are mutually exclusive")
  }
  staged <- file.path(tempfile(), "kernelspec")
  dir.create(staged, recursive = TRUE)
  on.exit(unlink(dirname(staged), recursive = TRUE))
  logos <- list.files(system.file("kernelspec", package = "IRkernel"), pattern = "^logo", full.names = TRUE)
  file.copy(logos, staged)
  spec <- fromJSON(system.file("kernelspec", "kernel.json", package = "IRdag"))
  spec$argv[[1L]] <- file.path(R.home("bin"), "R")
  spec$display_name <- displayname
  if (!is.null(lib)) {
    spec$env <- list(R_LIBS = normalizePath(lib))
  }
  write(toJSON(spec, pretty = TRUE, auto_unbox = TRUE), file = file.path(staged, "kernel.json"))
  args <- c(
    "kernelspec", "install", "--replace", "--name", name,
    if (user) "--user",
    if (!is.null(prefix)) c("--prefix", prefix),
    if (sys_prefix) "--sys-prefix",
    if (!verbose) "--log-level=WARN",
    staged
  )
  invisible(system2("jupyter", args))
}
