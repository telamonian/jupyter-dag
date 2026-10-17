analyze <- IRdag:::analyze_cell

names_of <- function(result, field) unlist(result[[field]])

test_that("an assignment defines, a read references, builtins stay referenced", {
  r <- analyze("a", "df <- read.csv(path)\nprint(df)")
  expect_equal(r$status, "ok")
  expect_equal(names_of(r, "defined"), "df")
  expect_equal(names_of(r, "referenced"), c("path", "print", "read.csv"))
  expect_equal(r$deleted, list())
  expect_false(r$dynamic)
})

test_that("a name both read and bound is only defined, as in the Python kernel", {
  r <- analyze("a", "x <- x + 1")
  expect_equal(names_of(r, "defined"), "x")
  expect_false("x" %in% names_of(r, "referenced"))
  r <- analyze("b", "print(y); y <- 1")
  expect_equal(names_of(r, "defined"), "y")
})

test_that("name lists serialise as arrays even with one entry", {
  r <- analyze("a", "x <- 1")
  expect_type(r$defined, "list")
  expect_equal(jsonlite::toJSON(r$defined, auto_unbox = TRUE), structure("[\"x\"]", class = "json"))
})

test_that("replacement targets are referenced, not defined", {
  r <- analyze("a", "x[1] <- 2\nnames(y)[2] <- 'b'")
  expect_equal(r$defined, list())
  expect_true(all(c("x", "y") %in% names_of(r, "referenced")))
})

test_that("function bodies bind locals; <<- and literal assign() define globals", {
  r <- analyze("a", "f <- function(a) { b <- a + k; b }")
  expect_equal(names_of(r, "defined"), "f")
  expect_equal(names_of(r, "referenced"), "k")
  r <- analyze("b", "g <- function() counter <<- counter + 1")
  expect_equal(names_of(r, "defined"), c("counter", "g"))
  r <- analyze("c", "h <- function() assign('inner', 1)\nassign('outer', 2)\nassign('global', 3, envir = .GlobalEnv)")
  expect_equal(names_of(r, "defined"), c("global", "h", "outer"))
  expect_false(r$dynamic)
})

test_that("a top-level for loop binds its variable", {
  r <- analyze("a", "for (i in 1:3) total <- total + i")
  expect_equal(names_of(r, "defined"), c("i", "total"))
})

test_that("operators, reserved words and pkg::name are not names", {
  r <- analyze("a", "if (TRUE) z <- dplyr::filter(df, a > 1) else z <- NULL")
  expect_equal(names_of(r, "defined"), "z")
  expect_equal(names_of(r, "referenced"), c("a", "df"))
})

test_that("rm() with literal names deletes; a computed list is dynamic", {
  r <- analyze("a", "x <- 1\nrm(x, 'y', list = c('z'))")
  expect_equal(r$defined, list())
  expect_equal(names_of(r, "deleted"), c("x", "y", "z"))
  expect_false("x" %in% names_of(r, "referenced"))
  expect_false(r$dynamic)
  r <- analyze("b", "rm(list = ls())")
  expect_true(r$dynamic)
})

test_that("dynamic calls set the flag", {
  expect_true(analyze("a", "eval(parse(text = code))")$dynamic)
  expect_true(analyze("b", "source('setup.R')")$dynamic)
  expect_true(analyze("c", "assign(name, 1)")$dynamic)
  expect_true(analyze("d", "v <- get('x')")$dynamic)
  expect_false(analyze("e", "x <- 1")$dynamic)
})

test_that("local() and with() do not bind globals", {
  r <- analyze("a", "local({ tmp <- 1 })\nwith(df, s <- sum(v))")
  expect_equal(r$defined, list())
  expect_true("df" %in% names_of(r, "referenced"))
})

test_that("library() defines the attached exports, including Depends", {
  r <- analyze("a", "library(stats)")
  expect_true(all(c("sd", "lm") %in% names_of(r, "defined")))
  expect_false(r$dynamic)
  r <- analyze("b", "require('stats')")
  expect_true("sd" %in% names_of(r, "defined"))
  r <- analyze("c", "library(pkg, character.only = TRUE)")
  expect_true(r$dynamic)
  expect_equal(r$defined, list())
  r <- analyze("d", "library(no.such.package.here)")
  expect_true(r$dynamic)
})

test_that("Depends recursion and version stripping", {
  expect_equal(IRdag:::dependency_names("R (>= 3.5), ggplot2 (>= 3.0), methods"), c("ggplot2", "methods"))
})

test_that("a parse error is a per-cell error result", {
  r <- analyze("a", "x <- (")
  expect_equal(r$status, "error")
  expect_equal(r$ename, "ParseError")
  expect_match(r$evalue, "unexpected end of input")
})

test_that("an empty or comment-only cell analyses to nothing", {
  r <- analyze("a", "# just a comment\n")
  expect_equal(r$status, "ok")
  expect_equal(r$defined, list())
  expect_equal(r$referenced, list())
})

test_that("missing arguments and formals without defaults do not break the walk", {
  r <- analyze("a", "m <- x[1, ]\nf <- function(a, b = a) NULL")
  expect_equal(names_of(r, "defined"), c("f", "m"))
  expect_equal(names_of(r, "referenced"), "x")
})

test_that("analyze_cells accepts the data frame fromJSON makes and a list of lists", {
  json <- '{"cells":[{"cell_id":"a","code":"x <- 1"},{"cell_id":"b","code":"y <- x"}]}'
  from_frame <- IRdag:::analyze_cells(jsonlite::fromJSON(json)$cells)
  from_list <- IRdag:::analyze_cells(list(list(cell_id = "a", code = "x <- 1"), list(cell_id = "b", code = "y <- x")))
  expect_equal(from_frame, from_list)
  expect_equal(vapply(from_frame, `[[`, "", "cell_id"), c("a", "b"))
  expect_equal(names_of(from_frame[[2]], "referenced"), "x")
  expect_equal(IRdag:::analyze_cells(jsonlite::fromJSON('{"cells":[]}')$cells), list())
  expect_error(IRdag:::analyze_cells(list(list(code = "x"))), "cell_id")
})
