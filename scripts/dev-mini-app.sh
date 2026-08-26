#!/usr/bin/env bash
# Full local Mini App stack: brain sidecar, optional execution sidecar, mini-app UI.
# Portfolio reads chain RPC; ledger / compose / voice read brain (8788).
# Trade flush needs execution sidecar when WORLD_PRIVATE_KEY is set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OPEN_BROWSER=0
SKIP_SIDECAR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --open)
      OPEN_BROWSER=1
      shift
      ;;
    --no-sidecar)
      SKIP_SIDECAR=1
      shift
      ;;
    -h | --help)
      cat <<'EOF'
Usage: scripts/dev-mini-app.sh [--open] [--no-sidecar]

Starts the local Mini App dev stack:
  - brain sidecar (ledger, watches, compose, voice records)
  - execution sidecar (only if WORLD_PRIVATE_KEY is in .env and not --no-sidecar)
  - world-mini-app HTTP server (UI + API)

Requires .env with at least WORLD_ACCOUNT_ID. For browser dev without Telegram:
  MINI_APP_DEV_BYPASS=1

Options:
  --open        Open http://127.0.0.1:8080/?preview=dev in the default browser
  --no-sidecar  Skip execution sidecar even when WORLD_PRIVATE_KEY is set
EOF
      exit 0
      ;;
    *)
      echo "unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "copy .env.example to .env and set WORLD_ACCOUNT_ID (and MINI_APP_DEV_BYPASS=1 for browser dev)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

env_val() {
  local key="$1"
  local default="${2:-}"
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
  else
    printf '%s' "$default"
  fi
}

BRAIN_PORT="$(env_val WORLD_BRAIN_PORT 8788)"
BRAIN_HOST="$(env_val WORLD_BRAIN_HOST 127.0.0.1)"
EXEC_PORT="$(env_val WORLD_EXECUTION_PORT 8787)"
EXEC_HOST="$(env_val WORLD_EXECUTION_HOST 127.0.0.1)"
MINI_BIND="$(env_val MINI_APP_BIND 127.0.0.1:8080)"
MINI_HOST="${MINI_BIND%%:*}"
MINI_PORT="${MINI_BIND##*:}"
if [[ "$MINI_HOST" == "$MINI_PORT" ]]; then
  MINI_HOST="127.0.0.1"
  MINI_PORT="$MINI_BIND"
fi

if [[ -z "$(env_val WORLD_ACCOUNT_ID)" ]]; then
  echo "WORLD_ACCOUNT_ID is not set in .env — portfolio and ledger will fail" >&2
fi

http_ok() {
  curl -sf --max-time 1 "$1" >/dev/null 2>&1
}

if http_ok "http://${BRAIN_HOST}:${BRAIN_PORT}/health"; then
  echo "brain already listening on ${BRAIN_HOST}:${BRAIN_PORT} — stop it or set WORLD_BRAIN_PORT" >&2
  exit 1
fi
if http_ok "http://${MINI_HOST}:${MINI_PORT}/api/v1/mini-app/health"; then
  echo "mini-app already listening on ${MINI_HOST}:${MINI_PORT} — stop it or set MINI_APP_BIND" >&2
  exit 1
fi

if [[ "$(env_val MINI_APP_DEV_BYPASS)" != "1" ]] \
  && [[ "$(env_val MINI_APP_DEV_BYPASS)" != "true" ]] \
  && [[ -z "$(env_val TELEGRAM_BOT_TOKEN)" ]]; then
  echo "hint: set MINI_APP_DEV_BYPASS=1 for local browser testing without Telegram" >&2
fi

if [[ ! -d brain/node_modules ]]; then
  echo "installing brain dependencies…"
  (cd brain && npm install)
fi

START_SIDECAR=0
if [[ "$SKIP_SIDECAR" -eq 0 ]] && [[ -n "$(env_val WORLD_PRIVATE_KEY)" ]]; then
  if http_ok "http://${EXEC_HOST}:${EXEC_PORT}/health"; then
    echo "execution sidecar already on ${EXEC_HOST}:${EXEC_PORT} — stop it or set WORLD_EXECUTION_PORT" >&2
    exit 1
  fi
  START_SIDECAR=1
  if [[ ! -d sidecar/node_modules ]]; then
    echo "installing execution sidecar dependencies…"
    (cd sidecar && npm install)
  fi
fi

echo "building world-mini-app and plugin…"
cargo build

BRAIN_LOG="${TMPDIR:-/tmp}/world-markets-brain.log"
EXEC_LOG="${TMPDIR:-/tmp}/world-markets-sidecar.log"

(cd brain && npm start) >"$BRAIN_LOG" 2>&1 &
BRAIN_PID=$!

EXEC_PID=""
if [[ "$START_SIDECAR" -eq 1 ]]; then
  (cd sidecar && npm start) >"$EXEC_LOG" 2>&1 &
  EXEC_PID=$!
fi

cleanup() {
  local pids=("$BRAIN_PID")
  if [[ -n "$EXEC_PID" ]]; then
    pids+=("$EXEC_PID")
  fi
  kill "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_http() {
  local name="$1"
  local url="$2"
  local pid="$3"
  local log="$4"
  local attempts="${5:-60}"
  local i=0
  while ((i < attempts)); do
    if curl -sf "$url" >/dev/null; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before becoming healthy; see $log" >&2
      cat "$log" >&2 || true
      exit 1
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "$name did not become healthy; see $log" >&2
  cat "$log" >&2 || true
  exit 1
}

wait_http "brain sidecar" "http://${BRAIN_HOST}:${BRAIN_PORT}/health" "$BRAIN_PID" "$BRAIN_LOG" 50

if [[ -n "$EXEC_PID" ]]; then
  wait_http "execution sidecar" "http://${EXEC_HOST}:${EXEC_PORT}/health" "$EXEC_PID" "$EXEC_LOG" 75
else
  echo "execution sidecar skipped (no WORLD_PRIVATE_KEY or --no-sidecar)"
fi

MINI_PREVIEW_URL="http://${MINI_HOST}:${MINI_PORT}/?preview=dev"
MINI_CHART_URL="http://${MINI_HOST}:${MINI_PORT}/chart?symbol=AAPL&period=d&preview=dev"

cat <<EOF

Mini App stack is up:
  UI (portfolio)  ${MINI_PREVIEW_URL}
  UI (chart)      ${MINI_CHART_URL}
  brain           http://${BRAIN_HOST}:${BRAIN_PORT}/health
EOF
if [[ -n "$EXEC_PID" ]]; then
  echo "  execution       http://${EXEC_HOST}:${EXEC_PORT}/health"
fi
if ! command -v aomi-run >/dev/null 2>&1; then
  echo "  (install aomi-run so hold-to-talk can execute locally via --prompt)"
fi
cat <<EOF

Logs:
  brain           ${BRAIN_LOG}
EOF
if [[ -n "$EXEC_PID" ]]; then
  echo "  execution       ${EXEC_LOG}"
fi
echo "Press Ctrl+C to stop all services."
echo

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  command -v open >/dev/null && open "$MINI_PREVIEW_URL" || true
fi

exec cargo run -p world-mini-app
