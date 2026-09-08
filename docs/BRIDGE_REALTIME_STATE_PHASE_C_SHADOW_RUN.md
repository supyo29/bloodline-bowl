# Bridge Real-Time State — Stage C: Shadow Comparison Report

Generated: 2026-09-08T02:43:12.013Z

**Operationally read-only.** In-memory persistence; `dryRun: true`; only Sleeper GETs.
Pointer rows written to production: **0** (by construction — the harness never
receives the real persistence bundle).

## bloodline-bowl

| field | value |
| --- | --- |
| old observation | `snap:bloodline-bowl:2026:w1:1af3658949f1d670` |
| new observation | `snap:bloodline-bowl:2026:w1:1af3658949f1d670` |
| source stable during comparison? | **yes** |
| source start hash | `1af3658949f1d670` |
| source end hash | `1af3658949f1d670` |
| domains compared | league, standings, rosters, ownership, managers, matchups, players, transactions |
| Layer A (deterministic) verdict | EQUIVALENT (unexplained 0) |
| Layer B verdict | **EQUIVALENT** |
| reconcile / certification | CERTIFIED |
| capability health | `integrity=CERTIFIED degraded[free_agent_pool=UNAVAILABLE]` |

### Difference taxonomy (Layer B)

| category | count |
| --- | --- |
| EXPECTED_METADATA | 0 |
| EXPECTED_ORDERING | 0 |
| SOURCE_MOVED_DURING_RUN | 0 |
| CORRECTED_IDENTITY | 0 |
| CORRECTED_STALE_STATE | 0 |
| KNOWN_OLD_PATH_BUG | 0 |
| OPTIONAL_CAPABILITY_DIFFERENCE | 0 |
| UNEXPLAINED | 0 |

### P0 direct-route surface comparison

| surface | timing-only | semantic | notes |
| --- | --- | --- | --- |
| standings+managers+matchups (raw rosters/users/matchups) | 0 | 0 | — |
| transactions (week feed) | 0 | 0 | — |

### Model-input equivalence (team-state, identical schedule both sides)

- teams compared: 12
- divergent teams: **none**

### Legacy live vs published pointer (§16)

- published-pointer store not configured in this environment

## devoted-to-the-game

| field | value |
| --- | --- |
| old observation | `snap:devoted-to-the-game:2026:w1:22479a5b6e50687c` |
| new observation | `snap:devoted-to-the-game:2026:w1:22479a5b6e50687c` |
| source stable during comparison? | **yes** |
| source start hash | `22479a5b6e50687c` |
| source end hash | `22479a5b6e50687c` |
| domains compared | league, standings, rosters, ownership, managers, matchups, players, transactions |
| Layer A (deterministic) verdict | EQUIVALENT (unexplained 0) |
| Layer B verdict | **EQUIVALENT** |
| reconcile / certification | CERTIFIED |
| capability health | `integrity=CERTIFIED degraded[free_agent_pool=UNAVAILABLE]` |

### Difference taxonomy (Layer B)

| category | count |
| --- | --- |
| EXPECTED_METADATA | 0 |
| EXPECTED_ORDERING | 0 |
| SOURCE_MOVED_DURING_RUN | 0 |
| CORRECTED_IDENTITY | 0 |
| CORRECTED_STALE_STATE | 0 |
| KNOWN_OLD_PATH_BUG | 0 |
| OPTIONAL_CAPABILITY_DIFFERENCE | 0 |
| UNEXPLAINED | 0 |

### P0 direct-route surface comparison

| surface | timing-only | semantic | notes |
| --- | --- | --- | --- |
| standings+managers+matchups (raw rosters/users/matchups) | 0 | 0 | — |
| transactions (week feed) | 0 | 0 | — |

### Model-input equivalence (team-state, identical schedule both sides)

- teams compared: 12
- divergent teams: **none**

### Legacy live vs published pointer (§16)

- published-pointer store not configured in this environment

## sportys-alumni

- comparison mode: **NOT APPLICABLE** — publication path skips this league
- reason: `league status is "pre_draft" — no management state to publish`
- capability health: `integrity=CERTIFIED degraded[matchups=DEGRADED,free_agent_pool=UNAVAILABLE,draft_availability=DEGRADED]`

## Aggregate

| gate | result |
| --- | --- |
| deterministic same-source: unexplained = 0 | **PASS** |
| live shadow (stable-source runs): unexplained = 0 | **PASS** |
| pointer rows written by shadow run | 0 (expected 0) |
| model files changed | none |

> No unexplained differences on stable-source runs. Cleared for Stage D scoping.
