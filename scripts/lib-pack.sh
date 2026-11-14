# Checks on a packed Oerba.app, sourced by scripts/verify-pack.sh (an unsigned pack) and scripts/release.sh (the release build).
# Each function prints what it found and returns non-zero if the app is not as electron-builder.yml says it should be.

# The fuses, read back from the app and compared with `electronFuses` in electron-builder.yml.
assert_fuses() {
  local app="$1" out bad=0 line
  out="$(node node_modules/@electron/fuses/dist/bin.js read --app "$app")"
  echo "$out"
  for line in "RunAsNode is Disabled" "EnableCookieEncryption is Enabled" "EnableNodeOptionsEnvironmentVariable is Disabled" \
              "EnableNodeCliInspectArguments is Disabled" "EnableEmbeddedAsarIntegrityValidation is Enabled" \
              "OnlyLoadAppFromAsar is Enabled" "GrantFileProtocolExtraPrivileges is Disabled"; do
    if ! printf '%s\n' "$out" | grep -qxF "  $line"; then echo "FUSE NOT AS CONFIGURED: expected '$line'" >&2; bad=1; fi
  done
  return $bad
}

# The packed app.asar holds none of the self-test's strings, and no tests, scripts or sources.
assert_no_selftest() {
  local app="$1" work="$2" bad=0 needle f
  npx --no-install @electron/asar extract "$app/Contents/Resources/app.asar" "$work/asar" >/dev/null 2>&1
  for needle in "--selftest" "selftest.ts" "oerba-origin" "other-origin" "present-ms" "smoke:" "example.invalid" "stand-in" "__open" "runSelftest"; do
    if grep -rqF -- "$needle" "$work/asar/main.js" "$work/asar/setup" "$work/asar/update" "$work/asar/preload-setup.js" "$work/asar/preload-update.js"; then
      echo "FOUND in the app code: $needle" >&2; bad=1
    else echo "absent: $needle"; fi
  done
  for f in test scripts src node_modules; do [ -e "$work/asar/$f" ] && { echo "FOUND in app.asar: $f/" >&2; bad=1; }; done
  return $bad
}
