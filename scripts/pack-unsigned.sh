#!/usr/bin/env bash
# Builds the packaged bundle and packs an UNSIGNED Oerba.app, dmg and zip into release/, to look at what is in them.
# It signs nothing, notarises nothing, publishes nothing and talks to no Apple or GitHub service. Run by npm run pack:unsigned.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build:app
export CSC_IDENTITY_AUTO_DISCOVERY=false
unset APPLE_KEYCHAIN_PROFILE APPLE_KEYCHAIN APPLE_API_KEY APPLE_ID
rm -rf release
npx electron-builder --mac --arm64 --publish never
ls -la release
