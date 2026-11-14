#!/usr/bin/env bash
# Oerba Desktop's release build. The OWNER runs this, on the Mac that holds the signing identity, in a terminal they are
# at (codesign and notarytool may ask the keychain for permission in a dialog only they can answer).
#
# What it does:
#   1. refuses a dirty working tree, a version already tagged, or a commit that is not on origin/main;
#   2. installs exactly what package-lock.json says (npm ci --ignore-scripts, then Electron's own install script) and runs the tests;
#   3. builds the packaged bundle and packs, signs (the keychain's "Developer ID Application" identity) and notarises
#      (notarytool, keychain profile "oerba-notary", then staples) the app, the dmg and the zip, into release/;
#   4. verifies them: codesign --verify --deep --strict, spctl on the app and on the dmg, xcrun stapler validate;
#   5. prints each file with its SHA-256, latest-mac.yml, and the command that makes the GitHub release.
#
# What it will not do: publish anything, create a tag or a release, upload to GitHub or push; it runs electron-builder with
# --publish never. Apple is contacted by notarytool alone, for the notarisation of this build.
#
# The next command is the owner's, and is printed at the end; it makes a DRAFT release, to be read on GitHub and published there.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "release: $*" >&2; exit 1; }

version="$(node -p "require('./package.json').version")"
tag="v$version"
commit="$(git rev-parse HEAD)"

echo "== checks before anything is built ($tag at ${commit:0:9})"
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean; commit or remove what git status shows."
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && fail "$tag is already tagged here."
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then fail "$tag is already on origin."; fi
git fetch --quiet origin main || fail "could not fetch origin/main."
git merge-base --is-ancestor "$commit" origin/main || fail "this commit is not on origin/main: push it first, so the release's tag lands on what was built."
security find-identity -v -p codesigning | grep -q "Developer ID Application" || fail "no 'Developer ID Application' identity in the keychain."

echo "== install exactly the locked packages, and the tests"
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test

echo "== pack, sign and notarise (a keychain dialog may ask you to allow codesign and notarytool)"
export APPLE_KEYCHAIN_PROFILE=oerba-notary
unset CSC_IDENTITY_AUTO_DISCOVERY CSC_LINK CSC_NAME APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY
rm -rf release
npm run build:app
npx electron-builder --mac --arm64 --publish never

app="release/mac-arm64/Oerba.app"
dmg="release/Oerba-$version-arm64.dmg"
zip="release/Oerba-$version-arm64-mac.zip"
[ -d "$app" ] && [ -f "$dmg" ] && [ -f "$zip" ] && [ -f release/latest-mac.yml ] || fail "electron-builder did not leave the files expected in release/."

echo "== verify"
codesign --verify --deep --strict --verbose=2 "$app"
spctl -a -vvv "$app"
xcrun stapler validate "$app"
# The dmg is not itself signed or notarised (the app inside is, and is stapled); spctl may say so. Shown, not fatal.
spctl -a -vvv -t install "$dmg" || echo "(spctl on the dmg: see the note above in the header; the app inside passed)"
xcrun stapler validate "$dmg" || echo "(the dmg itself carries no ticket; the app inside does)"

echo "== read the fuses back"
node node_modules/@electron/fuses/dist/bin.js read --app "$app"

echo "== files"
( cd release && shasum -a 256 "Oerba-$version-arm64.dmg" "Oerba-$version-arm64-mac.zip" "Oerba-$version-arm64.dmg.blockmap" "Oerba-$version-arm64-mac.zip.blockmap" latest-mac.yml )
echo "== latest-mac.yml"
cat release/latest-mac.yml

notes="release/notes-$tag.md"
{
  echo "Oerba Desktop $version"
  echo
  git log --format='- %s' "$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)..HEAD" | head -40
} > "$notes"

cat <<MSG

== built, signed, notarised and verified; nothing was published
Read and edit the notes: $notes
Then, as a DRAFT release (read it on GitHub, then publish it there):

  gh release create $tag \\
    $dmg $zip \\
    $zip.blockmap $dmg.blockmap release/latest-mac.yml \\
    --target $commit --draft --title "Oerba Desktop $version" --notes-file $notes

MSG
