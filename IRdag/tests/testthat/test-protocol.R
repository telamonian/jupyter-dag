test_that("the constants match the frontend's src/dag/protocol.ts", {
  ts <- file.path(testthat::test_path(), "..", "..", "..", "src", "dag", "protocol.ts")
  skip_if_not(file.exists(ts), "not inside the jupyter-dag checkout")
  src <- paste(readLines(ts, warn = FALSE), collapse = "\n")
  constant <- function(name) {
    m <- regmatches(src, regexec(sprintf("export const %s = '([^']*)'", name), src))[[1]]
    expect_length(m, 2)
    m[[2]]
  }
  expect_equal(IRdag:::COMM_TARGET, constant("COMM_TARGET"))
  expect_equal(IRdag:::FEATURE_ANALYZE, constant("FEATURE_ANALYZE"))
  expect_equal(IRdag:::FEATURE_NAMESPACE_DELETE, constant("FEATURE_NAMESPACE_DELETE"))
  expect_equal(IRdag:::FEATURE_NAMESPACE_SET, constant("FEATURE_NAMESPACE_SET"))
  expect_equal(IRdag:::FEATURE_NAMESPACE_DELTA, constant("FEATURE_NAMESPACE_DELTA"))
  expect_equal(IRdag:::ANALYZE_REQUEST, constant("ANALYZE_REQUEST"))
  expect_equal(IRdag:::ANALYZE_REPLY, constant("ANALYZE_REPLY"))
})

test_that("the shipped kernelspec names the entry point", {
  spec <- jsonlite::fromJSON(system.file("kernelspec", "kernel.json", package = "IRdag"))
  expect_equal(spec$argv, c("R", "--no-echo", "-e", "IRdag::main()", "--args", "{connection_file}"))
  expect_equal(spec$language, "R")
  expect_equal(spec$display_name, IRdag:::DISPLAY_NAME)
})
