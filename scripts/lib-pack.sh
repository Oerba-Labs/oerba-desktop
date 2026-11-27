# Checks on a packed Oerba.app, sourced by scripts/verify-pack.sh (an unsigned pack) and scripts/release.sh (the release build).
# Each function prints what it found and returns non-zero if the app is not as electron-builder.yml says it should be.

# The fuses, read back from the app. Every fuse the pinned @electron/fuses knows must be named and as expected below (the first
# seven are `electronFuses` in electron-builder.yml; the last two are at Electron's own default, which is asserted here: a
# loaded browser-process V8 snapshot stays off, and WebAssembly trap handlers stay on). A fuse the readback cannot name
# ("undefined"), a line this list does not know, or a count other than nine, is fatal.
assert_fuses() {
  local app="$1" out bad=0 line count
  out="$(node node_modules/@electron/fuses/dist/bin.js read --app "$app")"
  echo "$out"
  for line in "RunAsNode is Disabled" "EnableCookieEncryption is Enabled" "EnableNodeOptionsEnvironmentVariable is Disabled" \
              "EnableNodeCliInspectArguments is Disabled" "EnableEmbeddedAsarIntegrityValidation is Enabled" \
              "OnlyLoadAppFromAsar is Enabled" "LoadBrowserProcessSpecificV8Snapshot is Disabled" \
              "GrantFileProtocolExtraPrivileges is Disabled" "WasmTrapHandlers is Enabled"; do
    if ! printf '%s\n' "$out" | grep -qxF "  $line"; then echo "FUSE NOT AS EXPECTED: '$line'" >&2; bad=1; fi
  done
  count="$(printf '%s\n' "$out" | grep -c '^  ')"
  if [ "$count" != 9 ]; then echo "FUSE READBACK HAS $count LINES, NOT 9" >&2; bad=1; fi
  if printf '%s\n' "$out" | grep -q 'undefined'; then echo "A FUSE THE READBACK CANNOT NAME" >&2; bad=1; fi
  return $bad
}

# The packed app.asar holds none of the self-test's strings, and no tests, scripts or sources.
assert_no_selftest() {
  local app="$1" work="$2" bad=0 needle f
  npx --no-install @electron/asar extract "$app/Contents/Resources/app.asar" "$work/asar" >/dev/null 2>&1
  for needle in "--selftest" "selftest.ts" "oerba-origin" "other-origin" "present-ms" "relay-upstream" "smoke:" "example.invalid" "stand-in" "__open" "runSelftest" "oerba-desktop-tamper" "OERBA_TAMPER" "tamper-test" "5E5E5E5E-0000-4000-8000-5E5E5E5E5E5E"; do
    if grep -rqF -- "$needle" "$work/asar/main.js" "$work/asar/setup" "$work/asar/update" "$work/asar/simbar" "$work/asar/preload-setup.js" "$work/asar/preload-update.js" "$work/asar/preload-simbar.js"; then
      echo "FOUND in the app code: $needle" >&2; bad=1
    else echo "absent: $needle"; fi
  done
  for f in test scripts src node_modules; do [ -e "$work/asar/$f" ] && { echo "FOUND in app.asar: $f/" >&2; bad=1; }; done
  return $bad
}

# The iPhone panel's helper beside app.asar (Contents/Resources/serve-sim): the version package.json pins, the parts
# scripts/stage-serve-sim.mjs carries, and none it leaves out. With "signed", every binary and bundle in it must also verify
# strictly and carry the app's own Team ID: the helper process runs under the hardened runtime with library validation on, so a
# native addon or framework signed by anyone else would not load.
assert_serve_sim() {
  local app="$1" mode="${2:-}" bad=0 root want have team f t
  root="$app/Contents/Resources/serve-sim/node_modules"
  want="$(node -p "require('./package.json').devDependencies['@expo/serve-sim']")"
  have="$(node -p 'require(require("node:path").resolve(process.argv[1])).version' "$root/@expo/serve-sim/package.json" 2>/dev/null || echo none)"
  if [ "$have" = "$want" ]; then echo "serve-sim $have"; else echo "SERVE-SIM IS $have, NOT $want" >&2; bad=1; fi
  for f in dist/serve-sim.js dist/native/serve-sim-native.node dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC \
           dist/capability-loader/libServeSimCapabilityLoader.dylib LICENSE NOTICE; do
    [ -e "$root/@expo/serve-sim/$f" ] || { echo "MISSING from serve-sim: $f" >&2; bad=1; }
  done
  [ -f "$root/ws/wrapper.mjs" ] || { echo "MISSING: ws" >&2; bad=1; }
  for f in dist/capture dist/simnet dist/simcam dist/middleware.js dist/middleware.cjs src Sources node_modules; do
    [ -e "$root/@expo/serve-sim/$f" ] && { echo "FOUND in serve-sim, which should be left out: $f" >&2; bad=1; }
  done
  if [ "$mode" = signed ]; then
    team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
    [ -n "$team" ] && [ "$team" != "not set" ] || { echo "THE APP HAS NO TEAM ID" >&2; return 1; }
    while IFS= read -r -d '' f; do
      file -b "$f" | grep -q '^Mach-O' || continue
      t="$(codesign -dv "$f" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
      if codesign --verify --strict "$f" 2>/dev/null && [ "$t" = "$team" ]; then echo "signed: ${f#"$root"/}"
      else echo "NOT SIGNED BY THE APP'S TEAM: ${f#"$root"/} (${t:-none})" >&2; bad=1; fi
    done < <(find "$root" -type f -print0)
    while IFS= read -r -d '' f; do
      codesign --verify --strict "$f" 2>/dev/null && echo "bundle verifies: ${f#"$root"/}" || { echo "BUNDLE DOES NOT VERIFY: ${f#"$root"/}" >&2; bad=1; }
    done < <(find "$root" -type d \( -name '*.framework' -o -name '*.app' \) -print0)
  fi
  return $bad
}
