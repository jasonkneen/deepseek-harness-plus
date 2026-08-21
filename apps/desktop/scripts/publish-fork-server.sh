#!/bin/zsh
# Build a self-contained `dsh web` server binary for the host platform/arch and
# publish it, so the desktop app's DSH_DESKTOP_DOWNLOAD_URL can fetch and run it.
# This keeps the desktop app small — the (~780 MB) harness closure ships as one
# pkg executable here instead of being bundled into the app.
#
# Usage:
#   scripts/publish-fork-server.sh --upload
#   scripts/publish-fork-server.sh           # build only; prints where to host
#
# After upload, set on the desktop app:
#   DSH_DESKTOP_DOWNLOAD_URL=https://github.com/<you>/<repo>/releases/latest/download/dsh-server
# (the script publishes dsh-server-<platform>-<arch>; the app appends the pair.)
set -euo pipefail
cd "$(dirname "$0")/../.." # repository root

UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1
OUT="apps/desktop/publish-server"
PLAT="$([ "$(uname -s)" = Darwin ] && echo darwin || echo linux)"
ARCH="$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)"
NAME="dsh-server-${PLAT}-${ARCH}"

echo ">> Building the fork's dsh closure (pnpm deploy, prod)…"
rm -rf "$OUT"
pnpm --filter @deepseek-ai/dsh deploy --legacy --prod "$OUT"

# The deployed project lands at the target root; its CLI bin is the entry.
ENTRY="$OUT/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$ENTRY" ]; then
  echo "ERROR: deployed CLI entry not found at $ENTRY" >&2
  exit 1
fi

echo ">> Packaging a self-contained executable with pkg…"
# Same pkg route the repo uses for its single-exe runtime (see
# scripts/build-exe-for-python-sdk.ts): pack the deployed closure into one binary.
mkdir -p "$OUT/serve"
pkg "$ENTRY" \
  --target "node24-${PLAT}-${ARCH}" \
  --output "$OUT/serve/$NAME" \
  --config "$OUT/package.json" 2>/dev/null || {
    echo "WARN: pkg did not run (is @yao-pkg/pkg available?). Fall back to ELECTRON_RUN_AS_NODE flow." >&2
}

# Ship the web UI static assets alongside (the server reads them from disk).
SERVE_DIR="$OUT/node_modules/@deepseek-ai/dsh-web-app/dist"
if [ -d "$SERVE_DIR" ]; then
  cp -R "$SERVE_DIR" "$OUT/serve/web-ui" 2>/dev/null || true
fi

echo ">> Built server payload:"
ls -lh "$OUT/serve/" 2>/dev/null || true

if [ "$UPLOAD" = "1" ]; then
  gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated" >&2; exit 1; }
  REPO="jasonkneen/deepseek-harness-plus"
  if [ -f "$OUT/serve/$NAME" ]; then
    echo ">> Uploading $NAME to a $REPO release…"
    gh release upload "dsh-server" "$OUT/serve/$NAME" --repo "$REPO" --clobber 2>/dev/null \
      || gh release create "dsh-server" "$OUT/serve/$NAME" --repo "$REPO" --title "dsh server" --notes "self-contained dsh web server" >/dev/null 2>&1
    echo "  served at https://github.com/$REPO/releases/latest/download/$NAME"
  else
    echo ">> No pkg binary produced; host $OUT/serve/web-ui + the closure manually." >&2
  fi
fi
echo ">> Done. Set DSH_DESKTOP_DOWNLOAD_URL to the serve base so the desktop app fetches $(echo "$PLAT-$ARCH")."
