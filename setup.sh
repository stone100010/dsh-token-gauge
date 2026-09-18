#!/usr/bin/env bash
# Install / inspect helper for this DSH client plugin.
#
# The official way to install a DSH plugin is `dsh plugin --profile web add`,
# but that command is a thin pnpm forwarder: it needs pnpm on PATH, and it needs
# `dsh` itself to be reachable. Neither is guaranteed — a `npx`-launched dsh
# lives in a cache directory that never reaches an interactive shell's PATH — so
# this script does the equivalent by hand and locates `dsh` itself.
#
# Usage:
#   ./setup.sh install     link the plugin into the web profile
#   ./setup.sh verify      compose the profile tree and confirm the plugin resolves
#   ./setup.sh status      show install state, service state, and the port
#   ./setup.sh uninstall   remove the link and the manifest entries
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).name)' "$HERE/package.json")"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PORT="${DSH_PORT:-3080}"

info() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# Locate the dsh launcher without assuming it is on PATH: honour an explicit
# override, then PATH, then the npx cache, then a global npm prefix.
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

[ -f "$HERE/package.json" ] || die "not a package directory: $HERE"
[ -d "$PROFILE" ] || die "web profile not found at $PROFILE (run 'dsh web' once to initialize it)"

# Rewrite the profile manifest: add or remove the dependency and the bundle row.
# Idempotent, and it never touches any other entry.
edit_manifest() {
  local mode="$1"
  node -e '
    const fs = require("fs");
    const [file, name, link, mode] = process.argv.slice(1);
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    p.dependencies ||= {};
    p.dsh ||= {};
    p.dsh.profile ||= {};
    p.dsh.profile.bundles ||= [];
    if (mode === "add") {
      p.dependencies[name] = "link:" + link;
      if (!p.dsh.profile.bundles.includes(name)) p.dsh.profile.bundles.push(name);
    } else {
      delete p.dependencies[name];
      p.dsh.profile.bundles = p.dsh.profile.bundles.filter((b) => b !== name);
    }
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
  ' "$PROFILE/package.json" "$PKG_NAME" "$HERE" "$mode"
}

case "${1:-}" in
  install)
    # A scoped name needs its scope directory: node_modules/@scope/name, not
    # just node_modules/name. Missing this is the first failure a scoped plugin
    # hits, so create the full parent path.
    mkdir -p "$PROFILE/node_modules/$(dirname "$PKG_NAME")"
    ln -sfn "$HERE" "$PROFILE/node_modules/$PKG_NAME"
    edit_manifest add
    info "linked   : $PROFILE/node_modules/$PKG_NAME -> $HERE"
    info "manifest : $PROFILE/package.json (dependency + bundle row)"
    info ""
    info "Next:"
    info "  1) ./setup.sh verify          # confirm the loader resolves it (no server)"
    info "  2) ./restart-and-verify.sh    # restart dsh web and verify end to end"
    ;;

  uninstall)
    rm -f "$PROFILE/node_modules/$PKG_NAME"
    edit_manifest remove
    info "removed $PKG_NAME; restart dsh web for it to take effect."
    ;;

  verify)
    [ -n "$DSH_BIN" ] || die "could not find the dsh launcher; set DSH_BIN=/path/to/dsh"
    info "composing the web profile tree (read-only)…"
    out="$("$DSH_BIN" --profile web --dump-config 2>&1)" || {
      printf '%s\n' "$out" | tail -20
      die "dump-config failed (see above)"
    }
    if printf '%s' "$out" | grep -q "$PKG_NAME"; then
      info "OK: the loader tree contains $PKG_NAME"
      printf '%s\n' "$out" | grep -n "$PKG_NAME" | head -5
    else
      printf '%s\n' "$out" | tail -20
      die "the loader tree does not contain $PKG_NAME"
    fi
    ;;

  status)
    info "dsh       : ${DSH_BIN:-(not found — set DSH_BIN)}"
    info "profile   : $PROFILE"
    if [ -e "$PROFILE/node_modules/$PKG_NAME" ]; then
      info "installed : yes ($(readlink -f "$PROFILE/node_modules/$PKG_NAME"))"
    else
      info "installed : no"
    fi
    if pgrep -f 'bin/dsh web' >/dev/null 2>&1; then
      info "service   : running ($(pgrep -f 'bin/dsh web' | tr '\n' ' '))"
    else
      info "service   : not running"
    fi
    if command -v curl >/dev/null 2>&1; then
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
      info "port $PORT : ${code:-unreachable} (401 = healthy, just unauthenticated)"
    fi
    ;;

  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
