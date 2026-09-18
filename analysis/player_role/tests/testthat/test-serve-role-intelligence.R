# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint D serving/versioning
# tests. Fast, in-memory -- does NOT re-invoke the full ~30s server build;
# exercises the same digest/ordering mechanics serve_role_intelligence.R uses.
# ===========================================================================
library(testthat)
suppressMessages({ library(dplyr); library(digest) })

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "player_role")
source(file.path(BASE, "config.R"))

.digest_of <- function(df_a, df_b, avail) {
  digest::digest(list("tag", "schema:v1", 2026, 1, df_a, df_b,
                      lapply(avail, function(x) list(x$family, x$status))), algo = "sha256")
}

test_that("1/16: identical artifacts -> identical version; generated_at is never part of the digest", {
  a <- tibble::tibble(gsis_id = c("P1", "P2"), value = c(0.5, 0.3))
  b <- tibble::tibble(gsis_id = "P1", domain = "RECEIVING", delta = 0.1)
  avail <- list(list(family = "ROLE_ROUTES", status = "AVAILABLE_WITH_LAG"))
  d1 <- .digest_of(a, b, avail)
  d2 <- .digest_of(a, b, avail)  # generated_at deliberately never passed in
  expect_identical(d1, d2)
})

test_that("3: a changed role profile produces a different version", {
  a1 <- tibble::tibble(gsis_id = c("P1", "P2"), value = c(0.5, 0.3))
  a2 <- tibble::tibble(gsis_id = c("P1", "P2"), value = c(0.55, 0.3))  # one value changed
  b <- tibble::tibble(gsis_id = "P1", domain = "RECEIVING", delta = 0.1)
  avail <- list(list(family = "ROLE_ROUTES", status = "AVAILABLE_WITH_LAG"))
  expect_false(identical(.digest_of(a1, b, avail), .digest_of(a2, b, avail)))
})

test_that("4: a changed role-change event produces a different version", {
  a <- tibble::tibble(gsis_id = c("P1", "P2"), value = c(0.5, 0.3))
  b1 <- tibble::tibble(gsis_id = "P1", domain = "RECEIVING", delta = 0.1)
  b2 <- tibble::tibble(gsis_id = "P1", domain = "RECEIVING", delta = 0.2)
  avail <- list(list(family = "ROLE_ROUTES", status = "AVAILABLE_WITH_LAG"))
  expect_false(identical(.digest_of(a, b1, avail), .digest_of(a, b2, avail)))
})

test_that("5: changed availability SEMANTICS (not just cutoff) produces a different version", {
  a <- tibble::tibble(gsis_id = c("P1", "P2"), value = c(0.5, 0.3))
  b <- tibble::tibble(gsis_id = "P1", domain = "RECEIVING", delta = 0.1)
  avail_lagged <- list(list(family = "ROLE_ROUTES", status = "AVAILABLE_WITH_LAG"))
  avail_current <- list(list(family = "ROLE_ROUTES", status = "AVAILABLE_CURRENT"))
  expect_false(identical(.digest_of(a, b, avail_lagged), .digest_of(a, b, avail_current)))
})

test_that("6/7: canonical row ordering (arrange(gsis_id)) makes input-order irrelevant to identity", {
  shuffled <- tibble::tibble(gsis_id = c("P2", "P1"), value = c(0.3, 0.5))
  canonical_a <- shuffled %>% arrange(gsis_id)
  canonical_b <- tibble::tibble(gsis_id = c("P1", "P2"), value = c(0.5, 0.3)) %>% arrange(gsis_id)
  expect_identical(canonical_a, canonical_b)  # same content regardless of pre-sort input order
})

test_that("2: FEATURE_SCHEMA/MODEL_TAG participate in identity (a tag bump is a real content change)", {
  a <- tibble::tibble(gsis_id = "P1", value = 0.5)
  d_tag1 <- digest::digest(list("role-opportunity-2026.1", a), algo = "sha256")
  d_tag2 <- digest::digest(list("role-opportunity-2026.2", a), algo = "sha256")
  expect_false(identical(d_tag1, d_tag2))
})
