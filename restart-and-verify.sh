#!/usr/bin/env bash
# Restart dsh web and verify the plugin end to end, in one foreground session.
#
# Why this exists: verification needs the one-time token that `dsh web` prints at
# startup, and restarting the server kills the agent session that would otherwise
# read it. Doing stop → start → capture token → verify inside one terminal is the
# only way to get a verdict without copying anything by hand.
#
# Usage:
#   ./restart-and-verify.sh                 stop the running server, restart, verify
#   ./restart-and-verify.sh --no-stop       leave any running server alone
#   DSH_WORKSPACE=/path ./restart-and-verify.sh   boot with another workspace root
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).name)' "$HERE/package.json")"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PORT="${DSH_PORT:-3080}"
# The invoking directory is the workspace root dsh boots with; override when the
# server should serve a different project.
WORKSPACE="${DSH_WORKSPACE:-$PWD}"
STOP=1
[ "${1:-}" = "--no-stop" ] && STOP=0

info() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# Same launcher discovery as setup.sh: PATH, then the npx cache, then a global
# npm prefix, with DSH_BIN as an explicit override.
find_dsh() {
  if [ -n "${DSH_BIN:-}" ] && [ -x "${DSH_BIN}" ]; then printf '%s' "$DSH_BIN"; return 0; fi
  if command -v dsh >/dev/null 2>&1; then command -v dsh; return 0; fi
  local candidate
  for candidate in \
    "$HOME"/.npm/_npx/*/node_modules/.bin/dsh \
    "$(npm prefix -g 2>/dev/null || true)"/bin/dsh; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

DSH_BIN="$(find_dsh || true)"
[ -n "$DSH_BIN" ] || die "could not find the dsh launcher; set DSH_BIN=/path/to/dsh"
cd "$WORKSPACE" || die "workspace does not exist: $WORKSPACE"

# ── 1. install state ───────────────────────────────────────────────────────
info "── install ───────────────────────────────"
if [ -e "$PROFILE/node_modules/$PKG_NAME" ]; then
  info "linked    : $(readlink -f "$PROFILE/node_modules/$PKG_NAME")"
else
  die "not installed: run ./setup.sh install first"
fi
node -e '
  const p = require(process.argv[1]);
  const name = process.argv[2];
  const has = p.dependencies && p.dependencies[name];
  const inBundles = p.dsh && p.dsh.profile && p.dsh.profile.bundles.includes(name);
  console.log("dependency: " + (has ? "yes" : "no"));
  console.log("bundle row: " + (inBundles ? "yes" : "no"));
  process.exit(has && inBundles ? 0 : 1);
' "$PROFILE/package.json" "$PKG_NAME" || die "profile manifest is incomplete: rerun ./setup.sh install"

# ── 2. stop the running server ─────────────────────────────────────────────
list_service_pids() {
  ps -eo pid=,args= | awk '
    $2 ~ /(^|\/)node$/ && $0 ~ /\.bin\/dsh/ && $0 ~ / web($| )/ && $0 !~ /bash -c/ && $0 !~ /restart-and-verify/ { print $1 }
  '
}

if [ "$STOP" = "1" ]; then
  pids="$(list_service_pids || true)"
  if [ -n "$pids" ]; then
    info "stopping  : $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 40); do
      [ -z "$(list_service_pids)" ] && break
      sleep 0.25
    done
    still="$(list_service_pids || true)"
    if [ -n "$still" ]; then
      # shellcheck disable=SC2086
      kill -9 $still 2>/dev/null || true
      sleep 1
    fi
  else
    info "stopping  : (nothing running)"
  fi
fi

# ── 3. start in the foreground, capturing the startup line ─────────────────
LOG="$(mktemp -t dsh-web-XXXXXX.log)"
info ""
info "── starting dsh web (workspace root: $WORKSPACE) ──"
info "   log: $LOG"
info ""

"$DSH_BIN" web > >(tee "$LOG") 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' INT TERM

TOKEN=""
for _ in $(seq 1 120); do
  TOKEN="$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -n "$TOKEN" ] && break
  kill -0 $SERVER_PID 2>/dev/null || break
  sleep 0.5
done

if [ -z "$TOKEN" ]; then
  info ""
  die "no startup token captured; the URL printed above is still valid. log: $LOG"
fi

# ── 4. verify the plugin reached the boot graph ────────────────────────────
info ""
info "── verify ────────────────────────────────"
info "token captured (${#TOKEN} chars)"

boot="$(curl -s "http://127.0.0.1:$PORT/?token=$TOKEN" || true)"
if printf '%s' "$boot" | grep -q "$PKG_NAME"; then
  info "boot graph: FOUND $PKG_NAME"
  printf '%s' "$boot" | grep -o "$PKG_NAME[^\"']*" | head -3 | sed 's/^/            /'
else
  info "boot graph: $PKG_NAME NOT present"
  info "            first 400 bytes of the boot page:"
  printf '%s' "$boot" | head -c 400 | sed 's/^/            /'
  info ""
fi

info ""
info "── next ──────────────────────────────────"
info "1) open the tokenized URL printed above"
info "2) hard refresh once: Ctrl+Shift+R"
info "3) the meter appears in the bottom-right; drag its header to move it"
info ""
info "the server keeps running in the foreground; Ctrl+C stops it."
wait $SERVER_PID
