test_that("visible_names lists sorted non-dot bindings", {
  env <- new.env()
  assign("b", 1, env)
  assign("A", 2, env)
  assign(".hidden", 3, env)
  expect_equal(IRdag:::visible_names(env), c("A", "b"))
})

test_that("delete_names unbinds what is bound and ignores the rest", {
  env <- new.env()
  assign("x", 1, env)
  assign("y", 2, env)
  expect_equal(IRdag:::delete_names(c("y", "nope", "x"), env), c("y", "x"))
  expect_equal(ls(env), character())
  expect_equal(IRdag:::delete_names(list(), env), character())
  expect_equal(IRdag:::delete_names(NULL, env), character())
})

test_that("set_names binds decoded values and reports the names sorted", {
  env <- new.env()
  values <- jsonlite::fromJSON('{"n": 5, "v": [1, 2], "o": {"k": "v"}}')
  expect_equal(IRdag:::set_names(values, env), c("n", "o", "v"))
  expect_equal(get("n", env), 5L)
  expect_equal(get("v", env), c(1L, 2L))
  expect_equal(get("o", env), list(k = "v"))
  expect_equal(IRdag:::set_names(list(), env), character())
  expect_equal(IRdag:::set_names(NULL, env), character())
})

test_that("compute_delta is a set difference with sorted arrays", {
  delta <- IRdag:::compute_delta(c("a", "b"), c("b", "c"))
  expect_equal(delta, list(added = list("c"), removed = list("a")))
  expect_equal(IRdag:::compute_delta("x", "x"), list(added = list(), removed = list()))
})

test_that("handle_comm_request routes by type and reports errors in the protocol's shape", {
  env <- new.env()
  reply <- IRdag:::handle_comm_request(list(type = "analyze_request", cells = list(list(cell_id = "a", code = "x <- y"))))
  expect_equal(reply$status, "ok")
  expect_equal(reply$cells[[1]]$defined, list("x"))
  bad <- IRdag:::handle_comm_request(list(type = "bogus"))
  expect_equal(bad$status, "error")
  expect_match(bad$evalue, "bogus")
  expect_equal(IRdag:::handle_comm_request(list())$status, "error")
})
