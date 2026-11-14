#!/usr/bin/env bash
# Looks at the unsigned package npm run pack:unsigned made (release/mac-arm64/Oerba.app): which fuses are set, whether any of the
# self-test is in app.asar, and whether the packed app starts and draws its setup screen. It starts the app from a COPY signed
# ad hoc in a scratch folder, because an unsigned arm64 app is killed by macOS. Nothing is signed with the owner's identity,
# nothing is sent to Apple or GitHub, and the release folder is not changed.
set -euo pipefail
cd "$(dirname "$0")/.."
app="release/mac-arm64/Oerba.app"
[ -d "$app" ] || { echo "No $app: run npm run pack:unsigned first." >&2; exit 1; }
scratch="$(mktemp -d)"
trap 'pkill -f "$scratch/Oerba.app/Contents/MacOS/Oerba" 2>/dev/null || true; rm -rf "$scratch"' EXIT

echo "== fuses"
node node_modules/@electron/fuses/dist/bin.js read --app "$app"

echo "== the self-test is not in app.asar"
npx --no-install @electron/asar extract "$app/Contents/Resources/app.asar" "$scratch/asar" >/dev/null 2>&1
bad=0
for needle in "--selftest" "selftest.ts" "oerba-origin" "other-origin" "present-ms" "smoke:" "example.invalid" "stand-in" "__open" "runSelftest"; do
  if grep -rqF -- "$needle" "$scratch/asar/main.js" "$scratch/asar/setup" "$scratch/asar/update" "$scratch/asar/preload-setup.js" "$scratch/asar/preload-update.js"; then echo "FOUND in the app code: $needle"; bad=1; else echo "absent: $needle"; fi
done
for f in test scripts src; do [ -e "$scratch/asar/$f" ] && { echo "FOUND in app.asar: $f/"; bad=1; }; done
[ "$bad" = 0 ] || { echo "The self-test or the tests are in the package." >&2; exit 1; }

echo "== the packed app starts and draws its setup screen"
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
