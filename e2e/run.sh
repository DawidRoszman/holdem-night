#!/usr/bin/env bash
# Runs the Maestro web e2e suite against the dockerised stack.
#
#   ./e2e/run.sh            build + start the stack, run all flows, stop the stack
#   KEEP_UP=1 ./e2e/run.sh  leave the stack running afterwards
#   HEADED=1 ./e2e/run.sh   show the browser instead of running it headless
#   SCREEN_SIZE=1920x1080 ./e2e/run.sh   headless window size (default 1680x1240)
#   ./e2e/run.sh flows/03_fold.yaml   run a single flow
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
export WEB_PORT="${WEB_PORT:-8090}"
APP_URL="http://localhost:${WEB_PORT}"
MAESTRO="${MAESTRO:-$(command -v maestro || echo "$HOME/.maestro/bin/maestro")}"

# faster bots, and long enough between hands for assertions on the result
export BOT_DELAY_MS="${BOT_DELAY_MS:-300}"
export NEXT_HAND_DELAY_MS="${NEXT_HAND_DELAY_MS:-6000}"

echo "==> starting stack on ${APP_URL}"
docker compose -f "$ROOT/docker-compose.yml" up -d --build --wait

REMOTE_PID=""
cleanup() {
  [[ -n "$REMOTE_PID" ]] && kill "$REMOTE_PID" 2>/dev/null || true
  if [[ -z "${KEEP_UP:-}" ]]; then
    echo "==> stopping stack"
    docker compose -f "$ROOT/docker-compose.yml" down
  fi
}
trap cleanup EXIT

echo "==> starting remote WebSocket player (for the multiplayer flow)"
node remote-player.js "ws://localhost:${WEB_PORT}/ws" "Remote Table" &
REMOTE_PID=$!

TARGETS=("$@")
[[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=(flows)

# headless defaults to 1024x625, too small for the flows: use the size of a desktop browser window
HEADLESS=(--headless --screen-size "${SCREEN_SIZE:-1680x1240}")
[[ -n "${HEADED:-}" ]] && HEADLESS=()

echo "==> running maestro${HEADED:+ (headed)}"
"$MAESTRO" test "${HEADLESS[@]}" -e APP_URL="$APP_URL" \
  --format junit --output report.xml "${TARGETS[@]}"
