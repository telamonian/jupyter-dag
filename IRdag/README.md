# IRdag: the jupyter-dag kernel for R

An R package that runs [IRkernel](https://github.com/IRkernel/IRkernel) with the four jupyter-dag
kernel-protocol additions the Python `jupyter-dag` kernel has, so the DAG view and reactive
execution work on R notebooks unchanged:

- `analyze_request` on the shell and control channels, answered with the global names each cell
  defines, references and deletes, a `dynamic` flag, and per-cell parse errors.
- `namespace_delete` and `namespace_set` fields on `execute_request`.
- `namespace_delta` on every `execute_reply`.
- The four feature strings in `kernel_info_reply`'s `supported_features`, and the `jupyter-dag`
  comm target as the no-protocol-change transport.

`docs/protocol.md` in the repository root describes the protocol; this package is its R
implementation. The code is split like the Python kernel: `R/protocol.R` (constants and shapes),
`R/analysis.R` (static analysis), `R/namespace.R` (delete, set, delta on the global environment),
`R/comm.R` (the comm fallback), `R/kernel.R` (the kernel class and `main()`), `R/installspec.R`.

## How the analysis reads R

`codetools::findGlobals` resolves scopes for the names a cell reads, with the whole cell wrapped in
a function so that top-level assignments are locals of the wrapper: a name both read and bound in
one cell is reported as defined only, as the Python kernel does. A walk over the parse tree finds
what the cell binds (`<-`, `=`, a top-level `for`, `<<-` from any depth, `assign()` with a literal
name), unbinds (`rm()` with literal names) and does dynamically (`eval`, `source`, `get`,
`rm(list = ls())` and the like). Replacement assignments such as `x[1] <- v` reference `x` rather
than define it. A `library()` or `require()` call is reported as defining the package's exports and
those of its `Depends`, so a cell that calls `filter()` is wired to the cell that attached dplyr.

## Install

From the repository root, with R and the CRAN packages `IRkernel`, `codetools`, `jsonlite` and
(for the tests) `testthat` available:

```bash
R CMD INSTALL IRdag
Rscript -e 'IRdag::installspec(sys_prefix = TRUE)'
```

`installspec()` takes `user`, `prefix` and `sys_prefix` like `IRkernel::installspec()`, plus `lib`
to record an `R_LIBS` path in the spec when the package lives outside R's default libraries. The
kernel appears as "R (jupyter-dag)".

## Tests

```bash
Rscript -e 'testthat::test_dir("IRdag/tests/testthat")'
pytest IRdag/tests/python
```

The R tests cover the analysis, the namespace operations and the comm dispatch, and check the
protocol constants against `src/dag/protocol.ts`. The Python tests start the kernel through
`jupyter_client` and exercise every message type end to end; set `IRDAG_R_LIBS` when the package
is installed in a private library.

## Limitations

- Analysis is static. Non-standard evaluation (`subset(df, x > 1)`, formulas, `with()`) is read
  conservatively: names inside formulas are not referenced, names inside `subset()` arguments are.
- `library(tidyverse)` attaches packages from its own `.onAttach`, not from `Depends`, so only
  tidyverse's own exports are reported.
- IRkernel handles one message at a time, so an `analyze_request` on the control channel is answered
  between cells, not during one.
