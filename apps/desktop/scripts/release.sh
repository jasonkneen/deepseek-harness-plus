#!/bin/zsh
# Cut a desktop release in one command: bump the version, tag `vX.Y.Z`, then
# build, Developer-ID sign, notarize, staple, and upload the DMGs to the GitHub
# release. This is the convenience front door over `desktop:ship -- --upload`.
#
# The desktop manifest shares one version with the workspace root (the repo's
# `check-workspace-constraints` gate enforces it), so this script keeps those
# two in sync. The broader dsh family is versioned as a unit by
# `pnpm run release:dsh`; a repo-wide release should run that instead, then use
# this script for the tag + build + upload.
#
# Usage (from the repository root or anywhere):
#   pnpm --filter @deepseek-ai/dsh-desktop run desktop:release                   # patch bump
#   pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- minor
#   pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- 0.2.0
#   pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- 0.2.0 --push   # also git push
set -euo pipefail

# Resolve the app dir regardless of where pnpm invoked the script from.
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

PUSH=0
BUMP="patch"
VERSION=""
for a in "$@"; do
  case "$a" in
    --push) PUSH=1 ;;
    patch|minor|major) BUMP="$a" ;;
    *)
      if [[ "$a" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
        VERSION="$a"
      else
        echo "Ignoring unknown arg: $a"
      fi
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION=$(node -e "
    const p = require('./package.json')
    const b = process.argv[1]
    const [maj, min, pat] = p.version.split('-')[0].split('.').map(Number)
    const v = b === 'major' ? [maj + 1, 0, 0] : b === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1]
    process.stdout.write(v.join('.'))
  " "$BUMP")
fi
[[ "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || { echo "ERROR: '$VERSION' is not a clean X.Y.Z"; exit 1; }
TAG="v$VERSION"

echo ">> Bumping desktop + root manifest to v$VERSION"
node -e "
  const fs = require('fs')
  for (const f of ['./package.json', '../../package.json']) {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (p.version !== '$VERSION') {
      p.version = '$VERSION'
      fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n')
    }
  }
"

if [ "$PUSH" = "1" ]; then
  echo ">> Committing and tagging v$VERSION"
  # Path-limited commit: only the two manifests are committed, so a partially
  # staged working tree (e.g. an in-progress refactor) is never swept in.
  git commit -m "chore(desktop): v$VERSION" -- package.json ../../package.json
  git tag "$TAG"
  git push origin HEAD "$TAG"
else
  echo ">> Tagging v$VERSION (local; commit + push with --push)"
  git tag "$TAG"
fi

echo ">> Building, signing, notarizing, and uploading v$VERSION…"
exec scripts/ship-signed.sh "$VERSION" --upload
