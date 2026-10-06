#!/usr/bin/env bash
# Anonymous external validation of the public fantasy API.
# Run from any machine with NO Vercel login, cookies, tokens or bypass headers:
#   BASE=https://api.rosterintel.com scripts/validate-public-api.sh
set -u
BASE="${BASE:-https://api.rosterintel.com}"
pass=0; fail=0
check() { # name method path expect_status expect_ctype_substr
  local name="$1" method="$2" path="$3" want="$4" ctype="${5:-application/json}"
  local out code ct final
  out=$(curl -s -m 60 -X "$method" -o /tmp/pubapi.body -w '%{http_code}|%{content_type}|%{url_effective}|%{num_redirects}' "$BASE$path")
  code=${out%%|*}; rest=${out#*|}; ct=${rest%%|*}; final=${rest#*|}
  local ok=1
  [[ "$code" == "$want" ]] || ok=0
  [[ -z "$ctype" || "$ct" == *"$ctype"* ]] || ok=0
  head -c 400 /tmp/pubapi.body | grep -qiE 'vercel.com/login|Authentication Required|_vercel_sso' && ok=0
  if (( ok )); then pass=$((pass+1)); printf 'PASS %-34s %s %s -> %s %s\n' "$name" "$method" "$path" "$code" "$ct"
  else fail=$((fail+1)); printf 'FAIL %-34s %s %s -> %s %s (want %s) final=%s\n  %s\n' "$name" "$method" "$path" "$code" "$ct" "$want" "$final" "$(head -c 200 /tmp/pubapi.body)"; fi
}
echo "== common"
check providers GET /api/providers 200
check health GET /api/health 200
echo "== Bloodline Bowl (Sleeper)"
for p in /api/league/bloodline-bowl/state /api/leagues/bloodline-bowl /api/leagues/bloodline-bowl/managers \
         /api/transactions/bloodline-bowl "/api/matchups?league=bloodline-bowl" "/api/standings?league=bloodline-bowl" \
         "/api/roster-analysis?league=bloodline-bowl" /api/leagues/bloodline-bowl/draft; do check sleeper GET "$p" 200; done
echo "== Rogers Park (Yahoo)"
for p in /api/yahoo/status /api/yahoo/leagues/rogers-park "/api/yahoo/leagues/rogers-park/players/available?status=W&count=5" \
         /api/yahoo/leagues/rogers-park/provider-availability /api/league/rogers-park/state /api/transactions/rogers-park; do check yahoo GET "$p" 200; done
echo "== negative / method safety"
check post-read POST /api/league/rogers-park/state 405
check delete-yahoo DELETE /api/yahoo/leagues/rogers-park 405
check put-sleeper PUT /api/leagues/bloodline-bowl 405
check unknown-env GET /api/env 404
check yahoo-unregistered GET /api/yahoo/leagues/99999999 404
check account-discovery GET /api/yahoo/leagues 401
check cron-noauth GET /api/cron/capture 401
check refresh-get GET /api/refresh 405
check deep-health GET "/api/health?deep=1" 401
echo "== CORS preflight"
curl -s -i -m 20 -X OPTIONS -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: GET' "$BASE/api/league/rogers-park/state" | tr -d '\r' | grep -iE '^HTTP|^access-control' 
echo; echo "passed=$pass failed=$fail"; (( fail == 0 ))
