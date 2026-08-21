#!/bin/zsh
# One-time: store CI signing secrets for the desktop release workflow.
# Same recipe as the agensis / infinitty setup-signing-secrets.sh.
#
# Export the cert FIRST via Keychain Access (GUI) — exporting from the CLI
# grabs every identity in the keychain and blows GitHub's 48KB secret limit:
#   Keychain Access -> My Certificates -> "Developer ID Application: Jason
#   Kneen (SW75ZJJ5R6)" -> right-click -> Export -> .p12 with a password.
#
# Then (defaults to the fork's origin repository):
#   pnpm --filter @deepseek-ai/dsh-desktop run desktop:setup-signing-secrets
#     -- ~/Desktop/cert.p12
# or against an explicit repo:
#   GITHUB_REPOSITORY=jasonkneen/deepseek-harness-plus scripts/setup-signing-secrets.sh ~/Desktop/cert.p12
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${GITHUB_REPOSITORY:-jasonkneen/deepseek-harness-plus}"
P12="${1:?usage: setup-signing-secrets.sh <path-to-cert.p12>}"
if [ ! -f "$P12" ]; then
  echo "No such file: $P12"
  exit 1
fi
SIZE=$(stat -f %z "$P12")
if [ "$SIZE" -gt 20000 ]; then
  echo "That p12 is ${SIZE} bytes — it likely contains multiple identities."
  echo "Export ONLY the Developer ID Application cert from Keychain Access."
  exit 1
fi

read -s "P12PASS?Password you set when exporting the .p12: "; echo
gh secret set CSC_LINK --repo "$REPO" --body "$(base64 -i "$P12")"
gh secret set CSC_KEY_PASSWORD --repo "$REPO" --body "$P12PASS"
gh secret set CSC_NAME --repo "$REPO" --body "Developer ID Application: Jason Kneen (SW75ZJJ5R6)"

read "APPLEID?Apple ID email: "
gh secret set APPLE_ID --repo "$REPO" --body "$APPLEID"
echo "App-specific password: appleid.apple.com -> Sign-In & Security -> App-Specific Passwords"
read -s "APPPASS?App-specific password: "; echo
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO" --body "$APPPASS"
gh secret set APPLE_TEAM_ID --repo "$REPO" --body "SW75ZJJ5R6"

echo ""
echo "Signing secrets set on $REPO:"
echo "  CSC_LINK, CSC_KEY_PASSWORD, CSC_NAME"
echo "  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID"
echo ""
echo "Primary path is still local (keychain cert + notary profile):"
echo "  pnpm --filter @deepseek-ai/dsh-desktop run desktop:ship"
echo "  pnpm --filter @deepseek-ai/dsh-desktop run desktop:ship -- --upload   # after tagging vX.Y.Z"
echo ""
echo "CI (.github/workflows/desktop-release.yml) will sign/notarize when these"
echo "secrets exist. Until then, cut releases with desktop:ship."
echo "Finally: rm '$P12'"
