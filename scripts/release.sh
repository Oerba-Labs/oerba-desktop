#!/usr/bin/env bash
# Oerba Desktop's release build. The OWNER runs this, on the Mac that holds the signing identity, in a terminal they are
# at (codesign and notarytool may ask the keychain for permission in a dialog only they can answer).
#
# What it does:
#   1. refuses a dirty working tree, a version already tagged, or a commit that is not on origin/main;
#   2. installs exactly what package-lock.json says (npm ci --ignore-scripts, then Electron's own install script) and runs the tests and the forged-update run (npm run tamper);
#   3. builds the packaged bundle and packs the app, the dmg and the zip with electron-builder, signing them with the keychain's
#      "Developer ID Application" identity and notarising and stapling the APP (notarytool, keychain profile "oerba-notary");
#   4. notarises and staples the DMG as well (xcrun notarytool submit --wait, then xcrun stapler staple). Stapling changes the dmg's
#      bytes, so its entry in latest-mac.yml, and its blockmap, would no longer match: latest-mac.yml is rewritten to list the
#      zip alone, checked against the zip on disk, and the dmg's blockmap is not kept. The Mac updater installs from the zip;
#   5. checks, and stops at the first that fails: codesign --verify --deep --strict on the app; spctl on the app and
#      (-t install) on the dmg; xcrun stapler validate on the app and the dmg; every fuse read back from the app is as
#      configured; the iPhone panel's helper (Resources/serve-sim) is as staged and each binary in it signed by the app's team;
#      and the packed app.asar holds none of the self-test's strings;
#   6. refuses to start without release-notes/v<version>.md, written by hand, which is the release's notes; and prints each file's SHA-256 (after stapling), latest-mac.yml, and the command that makes the GitHub release.
#
# What it will not do: publish anything, create a tag or a release, upload to GitHub or push; it runs electron-builder with
# --publish never. Apple is contacted by notarytool alone, for the notarisation of this build's app and dmg.
#
# The next command is the owner's, and is printed at the end; it makes a DRAFT release, to be read on GitHub and published there.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib-pack.sh

fail() { echo "release: $*" >&2; exit 1; }

version="$(node -p "require('./package.json').version")"
tag="v$version"
commit="$(git rev-parse HEAD)"
notes="release-notes/$tag.md"

echo "== checks before anything is built ($tag at ${commit:0:9})"
[ -s "$notes" ] || fail "$notes is missing or empty: the release's notes are written in the repository, by hand, before the version is released."
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
npm run tamper

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

echo "== notarise and staple the dmg (Apple is contacted here)"
xcrun notarytool submit "$dmg" --keychain-profile oerba-notary --wait
xcrun stapler staple "$dmg"
# Its bytes changed: the zip alone is what latest-mac.yml may offer, and the dmg's blockmap no longer describes the dmg.
rm -f "$dmg.blockmap"
node scripts/finish-latest.mjs release "$version"

echo "== verify (each of these stops the release)"
codesign --verify --deep --strict --verbose=2 "$app"
spctl -a -vvv "$app"
xcrun stapler validate "$app"
spctl -a -vvv -t install "$dmg"
xcrun stapler validate "$dmg"
echo "-- fuses read back from the app"
assert_fuses "$app" || fail "a fuse is not as configured."
echo "-- the iPhone panel's helper: as staged, every binary in it signed by the app's own team"
assert_serve_sim "$app" signed || fail "serve-sim is not as staged, or not signed by the app's team."
echo "-- the self-test is not in the packed app.asar"
work="$(mktemp -d)"
assert_no_selftest "$app" "$work" || { rm -rf "$work"; fail "the self-test, tests or sources are in app.asar."; }
rm -rf "$work"

echo "== files, after stapling"
( cd release && shasum -a 256 "Oerba-$version-arm64.dmg" "Oerba-$version-arm64-mac.zip" "Oerba-$version-arm64-mac.zip.blockmap" latest-mac.yml )
echo "== latest-mac.yml"
cat release/latest-mac.yml

cat <<MSG

== built, signed, notarised and verified; nothing was published
The notes, written in the repository: $notes
Then, as a DRAFT release (read it on GitHub, then publish it there):

  gh release create $tag \\
    $dmg $zip \\
    $zip.blockmap release/latest-mac.yml \\
    --target $commit --draft --title "Oerba Desktop $version" --notes-file $notes

MSG
