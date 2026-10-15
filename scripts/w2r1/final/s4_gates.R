# S7 FINAL post-processing for S4 (K / D-ST): preregistered gates per slot x regime. Reads only artifacts of the final scorer + the frozen VAL result + FROZEN.json statuses.
suppressMessages({ library(data.table); library(jsonlite) }); source("scripts/w2r1/final/gates.R")
FIN <- readRDS("scripts/w2r1/cache/s4_final_rows.rds"); raw <- fromJSON("scripts/w2r1/results/final/s4_final_raw.json", simplifyVector = FALSE); val <- fromJSON("scripts/w2r1/results/s4_val.json", simplifyVector = FALSE); fz <- fromJSON("scripts/w2r1/FROZEN.json", simplifyVector = FALSE)
ceil <- setNames(lapply(fz$candidates, function(c) c$final_status_ceiling), sapply(fz$candidates, function(c) c$id)); out <- list()
for (k in names(FIN)) { id <- paste0("S4.", sub("\\|", ".", k)); d <- copy(FIN[[k]]); g <- gate_slot(d, val$results[[k]]$dMAE)
  orc <- raw$oracle[[k]]; t9 <- if (is.null(orc)) "NOT_COMPUTED_FOR_THIS_REGIME (oracle control run on Maclin D/ST+K and Rogers Park D/ST only); poison tests: PASS (720/720, 120/120)" else { om <- if (!is.null(orc$MAE_oracle_components_only)) orc$MAE_oracle_components_only else orc$MAE_oracle_counts
    if ((g$MAE_model - om) >= 0.25 * g$MAE_control) "PASS (oracle beats model by >=25% of control MAE; poison PASS)" else "FAIL" }
  g$gates$T9 <- t9; sp <- raw$spike[[k]]
  verdict <- if (identical(g$gates$T1, "INSUFFICIENT_FINAL_SAMPLE")) "INSUFFICIENT_FINAL_SAMPLE" else if (all(sapply(g$gates, function(x) grepl("^(PASS|NOT_APPLICABLE)", x)))) "ALL_PREREG_GATES_PASS" else "GATE_FAILURE"
  ceiling <- ceil[[id]]; status <- if (verdict == "ALL_PREREG_GATES_PASS" && grepl("^SHADOW_QUALIFIED", ceiling)) "SHADOW_QUALIFIED" else if (verdict == "INSUFFICIENT_FINAL_SAMPLE") "INSUFFICIENT_FINAL_SAMPLE" else if (grepl("DIAGNOSTIC_ONLY", ceiling)) "DIAGNOSTIC_ONLY" else "SHADOW_UNPROVEN"
  out[[id]] <- list(id = id, regime_slot = k, frozen_ceiling = ceiling, gate_verdict = verdict, final_status = status, expected_points = g, spike_diagnostic_only = sp) }
# post-open defect PO-1 (cluster definition in this new gate code): the Rogers Park D/ST confirmatory result is invalidated (see post_open_defects.json)
pod <- fromJSON("scripts/w2r1/results/final/post_open_defects.json", simplifyVector = FALSE)$defects[[1]]$verdict_changed_by_correction
for (id in names(out)) if (any(grepl(paste0("^", id, " "), unlist(pod)))) { out[[id]]$exploratory_gate_verdict <- out[[id]]$gate_verdict; out[[id]]$gate_verdict <- "INVALIDATED_BY_POST_OPEN_DEFECT"; out[[id]]$final_status <- "EXPLORATORY_PASS_NOT_CONFIRMATORY (not SHADOW_QUALIFIED)" }
write_json(out, "scripts/w2r1/results/final/s4_final.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)
for (id in names(out)) { o <- out[[id]]; e <- o$expected_points; cat(sprintf("%-34s n=%d dMAE %+.3f [%+.3f,%+.3f] RMSE %.2f/%.2f bias %+.2f wks+ %d | %s | %s\n  gates: %s\n", id, e$n, e$dMAE, e$dMAE_lo95, e$dMAE_hi95, e$RMSE_model, e$RMSE_control, e$bias_model, e$weeks_positive, o$gate_verdict, o$final_status, paste(names(e$gates), sapply(e$gates, function(x) substr(x, 1, 12)), collapse = " "))) }
