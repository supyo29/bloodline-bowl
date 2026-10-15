# W2.R1 S4 exact-scoring weights (provider-specific D/ST semantics; S7 adjudication). Sourced by s4_fit_eval.R and s7_kdst_coverage.R; mirrored in lib/w2r1/kdst.ts (golden-tested).
BL <- c("b0_19","b20_29","b30_39","b40_49","b50_59","b60p")
W <- function(rg, k, d = 0) { v <- rg$scoring[[k]]; if (is.null(v)) d else v }
wK <- function(rg) { fm <- W(rg, "fgm"); fx <- W(rg, "fgmiss"); list(
  make = c(W(rg,"fgm_0_19")+fm, W(rg,"fgm_20_29")+fm, W(rg,"fgm_30_39")+fm, W(rg,"fgm_40_49")+fm, (if (!is.null(rg$scoring$fgm_50_59)) W(rg,"fgm_50_59") else W(rg,"fgm_50p"))+fm, (if (!is.null(rg$scoring$fgm_60p)) W(rg,"fgm_60p") else W(rg,"fgm_50p"))+fm),
  miss = c(W(rg,"fgmiss_0_19")+fx, W(rg,"fgmiss_20_29")+fx, W(rg,"fgmiss_30_39")+fx, W(rg,"fgmiss_40_49")+fx, (if (!is.null(rg$scoring$fgmiss_50_59)) W(rg,"fgmiss_50_59") else W(rg,"fgmiss_50p"))+fx, (if (!is.null(rg$scoring$fgmiss_60p)) W(rg,"fgmiss_60p") else W(rg,"fgmiss_50p"))+fx),
  xpm = W(rg, "xpm"), xpmiss = W(rg, "xpmiss")) }
wD <- function(rg) { sl <- identical(rg$provider, "sleeper"); dk <- function(a, b) if (!is.null(rg$scoring[[a]])) W(rg, a) else W(rg, b)
  # PROVIDER-SPECIFIC semantics (S7 adjudication, verified against live 2025 provider stat lines):
  #  Sleeper: fum_rec = defensive recoveries, def_st_fum_rec = special-teams recoveries by the D/ST unit; ff = defensive forced fumbles, def_st_ff = ST forced fumbles; def_td = defensive TD, def_st_td = ST TD (KR/PR TDs). st_*/fum_rec_td are individual-player keys (not D/ST).
  #  Yahoo: Fumble Recovery covers defense AND special teams; "Touchdown" = defensive TD; KR/PR TD = st_td; no forced-fumble stat; fum_rec_td is an OFFENSIVE player key (not D/ST).
  list(sacks = W(rg,"sack"), sack_yd = W(rg,"sack_yd"), ints = W(rg,"int"), int_ret_yd = W(rg,"int_ret_yd"), fumrec_def = W(rg,"fum_rec"), fumrec_st = if (sl) W(rg,"def_st_fum_rec") else W(rg,"fum_rec"), fum_ret_yd = W(rg,"fum_ret_yd"),
  ff_def = if (sl) W(rg,"ff") else 0, ff_st = if (sl) W(rg,"def_st_ff") else 0, def_td = W(rg,"def_td"), st_td = if (sl) W(rg,"def_st_td") else W(rg,"st_td"), blk_td = if (sl) W(rg,"def_st_td") else W(rg,"def_td"), safeties = W(rg,"safe"), blk = W(rg,"blk_kick"), stops4 = W(rg,"def_4_and_stop"), forced_punts = W(rg,"def_forced_punts"),
  kr_yd = dk("def_kr_yd", "kr_yd"), pr_yd = dk("def_pr_yd", "pr_yd"), def2pt = W(rg,"def_2pt"), pa_cont = W(rg,"pts_allow"),
  pa_bins = c(W(rg,"pts_allow_0"), W(rg,"pts_allow_1_6"), W(rg,"pts_allow_7_13"), W(rg,"pts_allow_14_20"), W(rg,"pts_allow_21_27"), W(rg,"pts_allow_28_34"), W(rg,"pts_allow_35p"))) }
pa_score <- function(pa, w) { b <- ifelse(pa == 0, w$pa_bins[1], ifelse(pa <= 6, w$pa_bins[2], ifelse(pa <= 13, w$pa_bins[3], ifelse(pa <= 20, w$pa_bins[4], ifelse(pa <= 27, w$pa_bins[5], ifelse(pa <= 34, w$pa_bins[6], w$pa_bins[7]))))))
  b + w$pa_cont * pa }
actualK <- function(d, w) { s <- 0; for (i in 1:6) { a <- d[[paste0("att_", BL[i])]]; m <- d[[paste0("made_", BL[i])]]; s <- s + m * w$make[i] + (a - m) * w$miss[i] }; s + d$xp_made * w$xpm + (d$xp_att - d$xp_made) * w$xpmiss }
actualD <- function(d, w) { s <- 0; for (c in c("sacks","sack_yd","ints","int_ret_yd","fumrec_def","fumrec_st","fum_ret_yd","ff_def","ff_st","def_td","st_td","blk_td","safeties","blk","stops4","forced_punts","kr_yd","pr_yd","def2pt")) s <- s + d[[c]] * w[[c]]; s + pa_score(d$pa_actual, w) }
