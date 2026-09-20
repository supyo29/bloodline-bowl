# Phase 3.5B duplicate-interpretation guard: Player-Scheme's team-alias normalizer is a verbatim COPY of FI's
# (comment says "reuse FI's one team universe"). Until they are one function, they must never diverge.
root <- Sys.getenv("FI_ROOT")
extract_fn <- function(file, lhs) {
  for (e in parse(file.path(root, file))) {
    if (is.call(e) && identical(as.character(e[[1]]), "<-") && identical(deparse(e[[2]]), lhs)) return(eval(e[[3]]))
  }
  stop("definition not found: ", lhs, " in ", file)
}

test_that("PSI$normalize_team and FI$normalize_team agree on every alias and on canonical / odd inputs", {
  skip_if_not(requireNamespace("dplyr", quietly = TRUE))
  fi  <- extract_fn("analysis/football_intel/config.R", "FI$normalize_team")
  psi <- extract_fn("analysis/player_scheme_intelligence/config.R", "PSI$normalize_team")
  x <- c("OAK","SD","STL","LA","WSH","ARZ","BLT","CLV","HST","SL","JAC",       # aliases
         "LV","LAC","LAR","WAS","ARI","BAL","CLE","HOU","JAX","KC","NE","SF",   # canonical
         " oak ","la","Jac", NA, "")                                             # whitespace / case / NA / empty
  expect_identical(fi(x), psi(x))
  expect_equal(unname(fi(c("OAK","SD","STL","LA","WSH","JAC"))), c("LV","LAC","LAR","LAR","WAS","JAX"))
  expect_identical(fi("KC"), "KC")
})
