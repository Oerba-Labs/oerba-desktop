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
  for needle in "--selftest" "selftest.ts" "oerba-origin" "other-origin" "present-ms" "relay-upstream" "smoke:" "example.invalid" "stand-in" "__open" "runSelftest" "oerba-desktop-tamper" "OERBA_TAMPER" "tamper-test"; do
    if grep -rqF -- "$needle" "$work/asar/main.js" "$work/asar/setup" "$work/asar/update" "$work/asar/preload-setup.js" "$work/asar/preload-update.js"; then
      echo "FOUND in the app code: $needle" >&2; bad=1
    else echo "absent: $needle"; fi
  done
  for f in test scripts src node_modules; do [ -e "$work/asar/$f" ] && { echo "FOUND in app.asar: $f/" >&2; bad=1; }; done
  return $bad
}
