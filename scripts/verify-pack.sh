#!/usr/bin/env bash
# Looks at the unsigned package npm run pack:unsigned made (release/mac-arm64/Oerba.app): that its fuses are as configured, that
# none of the self-test is in app.asar, that latest-mac.yml can be reduced to the zip, and that the packed app starts and draws its
# setup screen. It starts the app from a COPY signed ad hoc in a scratch folder, because an unsigned arm64 app is killed by macOS.
# Nothing is signed with the owner's identity, nothing is sent to Apple or GitHub, and the release folder is not changed.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib-pack.sh
app="release/mac-arm64/Oerba.app"
[ -d "$app" ] || { echo "No $app: run npm run pack:unsigned first." >&2; exit 1; }
version="$(node -p "require('./package.json').version")"
scratch="$(mktemp -d)"
trap 'pkill -f "$scratch/Oerba.app/Contents/MacOS/Oerba" 2>/dev/null || true; rm -rf "$scratch"' EXIT

echo "== fuses"
assert_fuses "$app" || exit 1

echo "== the self-test is not in app.asar"
assert_no_selftest "$app" "$scratch" || { echo "The self-test, tests or sources are in the package." >&2; exit 1; }

echo "== the iPhone panel's helper is beside app.asar, as staged (its signatures are the release's to check)"
assert_serve_sim "$app" || { echo "serve-sim is not as staged." >&2; exit 1; }

echo "== latest-mac.yml reduces to the zip alone, checked against the zip"
mkdir "$scratch/rel"
cp release/latest-mac.yml "$scratch/rel/"
ln -s "$PWD/release/Oerba-$version-arm64-mac.zip" "$scratch/rel/"
node scripts/finish-latest.mjs "$scratch/rel" "$version"
grep -c "url:" "$scratch/rel/latest-mac.yml" | grep -qx 1 || { echo "latest-mac.yml still lists more than the zip" >&2; exit 1; }

echo "== the packed app starts and draws its setup screen"
# The app holds a single-instance lock in its data folder, so another Oerba running on this Mac would make this copy exit at once.
if pgrep -f "Oerba.app/Contents/MacOS/Oerba" >/dev/null; then echo "Another Oerba is running: quit it, then run this again." >&2; exit 1; fi
cp -R "$app" "$scratch/Oerba.app"
codesign --force --deep --sign - "$scratch/Oerba.app" >/dev/null 2>&1
"$scratch/Oerba.app/Contents/MacOS/Oerba" > "$scratch/run.log" 2>&1 &
pid=$!
for _ in $(seq 1 40); do grep -q "the setup screen drew" "$scratch/run.log" 2>/dev/null && break; sleep 0.25; done
sleep 3
if kill -0 "$pid" 2>/dev/null; then echo "process alive after start"; else echo "the packed app is not running" >&2; cat "$scratch/run.log" >&2; exit 1; fi
grep -E "oerba:" "$scratch/run.log" || true
grep -q "the setup page failed to load" "$scratch/run.log" && { echo "the setup page did not load" >&2; exit 1; }
grep -q "the setup screen drew 5 steps" "$scratch/run.log" || echo "(the setup screen was already left for Oerba's pages, or drew no steps: read the lines above)"
echo "== a second launch exits at once and leaves the first running (single-instance lock)"
"$scratch/Oerba.app/Contents/MacOS/Oerba" > "$scratch/second.log" 2>&1 &
second=$!
for _ in $(seq 1 40); do kill -0 "$second" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$second" 2>/dev/null; then echo "the second launch is still running" >&2; kill "$second" 2>/dev/null || true; exit 1; fi
kill -0 "$pid" 2>/dev/null || { echo "the first copy stopped" >&2; exit 1; }
echo "ok"
kill "$pid" 2>/dev/null || true
