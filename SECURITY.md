# The shell's rules

Oerba's pages are not trusted with the computer. The window they run in is built so that a page that went wrong, or a link that
leads somewhere it should not, finds nothing to reach. The rules are in `src/policy/` and tested without Electron; `src/shell/hardening.ts`
only wires them in.

- **Settings of every view:** `contextIsolation` on, `sandbox` on, no `nodeIntegration` (also not in workers or subframes), no `webviewTag`
  (a `<webview>` attach is refused), `webSecurity` on, no insecure content.
- **No bridge for remote pages.** No preload is given to Oerba's view or to any page but the bundled setup screen. The setup preload exposes
  three calls (`getState`, `onState`, `act`) through `contextBridge`, does nothing unless it runs in the bundled setup page's top frame, and the main process
  checks the sender's frame again on every message.
- **Navigation.** The setup view's main frame may only be the bundled setup page. Oerba's view's main frame may only be `https://app.oerba.dev`
  (no other port, no credentials in the address). Its subframes may be `https://*.oerba.dev` (Oerba frames workspace doors on those names). Everything else, including
  redirects, `file:`, `data:` and `javascript:`, is refused. A contents the app did not name may go nowhere.
- **Links out.** `window.open` never makes a window of ours. An `https:` address (with a host, no credentials) opens in the system browser with
  `shell.openExternal`, and any other scheme is dropped, but only when Oerba's own top frame asked for it, just after a key or mouse press in the window, one link
  for each press, and at most five a minute. A frame inside Oerba's page (a workspace door runs a developer's code) can never open the browser or send the page away:
  its requests are dropped and recorded. Electron does not say which frame called `window.open`, so the frame holding the focus stands for it. A plain link out of Oerba's
  page, if it is `https:`, goes to the browser under the same rule and the page stays.
- **No downloads.** Every download in every session is cancelled until a stage needs them.
- **Command-line switches.** A packaged app that finds any `-` switch on its command line beyond macOS's own `-psn_` refuses to start, with a dialog saying why
  (`src/policy/argv.ts`), so a launcher cannot loosen the shell with `--inspect`, `--no-sandbox` and the like. An unpackaged run is the developer's own and is not checked.
- **Permissions.** Every permission request and check is refused (media, notifications, geolocation, clipboard read, serial, USB, HID, Bluetooth and any kind not
  known), and so is every device permission. The `select-serial-port`, `select-usb-device`, `select-hid-device` and `select-bluetooth-device` choosers choose nothing.
  **One exception:** `clipboard-sanitized-write` (copy buttons) for `app.oerba.dev`'s own top frame, since writing text reads nothing.
  Devices are the app's own screens' to ask for one day, never a workspace's page.
- **Setup checks only read.** The only program run is Tailscale's `status --json`, by `execFile` with fixed arguments and no shell, and only its backend state is kept.
  Oerba is asked with a plain `GET /api/who`, no redirects followed, a timeout and a size limit.
- **The menu bar, notifications and badge only report.** They read `/api/now` and `/api/who` (a GET each, no redirects, a timeout, a 2 MB cap, a JSON object or nothing),
  never during setup. Every item and every notification click only opens the window at a route of Oerba's page; none sends anything to Oerba or presses anything. A route is built from
  workspace and owner names that match a plain-name pattern, URL-encoded, and is checked again before it is put in the page's address, by changing only the hash. Every string from Oerba
  is cut to a length and reduced to plain printable characters (no control, bidirectional or private-use characters) before it reaches the menu, a notification or the badge.
  No bridge is given to any page for this. A global shortcut sends ⌘K to Oerba's own page with `sendInputEvent`, as a key press, and nothing else. The login item changes only when the person ticks it.
- **Fuses, set in the packed app** (read back by `npm run verify:pack`): `RunAsNode` off, `EnableNodeCliInspectArguments` off, `EnableNodeOptionsEnvironmentVariable` off,
  `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `GrantFileProtocolExtraPrivileges` off, `EnableCookieEncryption` on. With the last off, a page inside `app.asar` does not load by
  `file://` at all, so the app's own pages (setup and update) are served by a scheme of the app's own, `oerba-app://app/`, registered standard and secure, from a fixed list of six files
  (`src/policy/bundled.ts`); a page cannot ask it for anything else in the package.
- **Sandbox, single instance.** `app.enableSandbox()` before anything starts. One instance holds a lock; a second launch only shows the first one's window and its arguments are never read.
  Screen and window recording requests (`getDisplayMedia`) are refused.
- **The self-test is not in the packaged app.** The packaged bundle is built with `__SELFTEST__` false and syntax simplification on, which removes the self-test, its stand-ins and its flags from the code;
  `npm run verify:pack` searches the packed `app.asar` for their strings. Tests and scripts are not in the package at all (only `build/app/` is packed), and electron-updater is bundled into `main.js`.
- **Signed with the hardened runtime**, under the owner's "Developer ID Application" identity, found in the keychain by its kind (no name, hash or team is written here), and notarised with notarytool through a
  keychain profile, then stapled. The only entitlement is `com.apple.security.cs.allow-jit`, which V8 needs to compile JavaScript at run time; `disable-library-validation`,
  `allow-unsigned-executable-memory`, `allow-dyld-environment-variables` and every device or file entitlement are not given.
- **Updates ask, and a forged one is refused.** electron-updater runs with `autoDownload` and `autoInstallOnAppQuit` off. The feed is the `publish` setting of the build (GitHub, `Oerba-Labs/oerba-desktop`), written
  into the app as `app-update.yml`; the app never calls `setFeedURL`, and nothing from a page or the command line reaches it. A package from anywhere else is refused twice: electron-updater checks the downloaded
  zip against the SHA-512 in `latest-mac.yml`, and macOS's Squirrel.Mac then installs it only if its code signature satisfies the running app's own requirement (the same team's Developer ID), so an unsigned
  or differently signed zip is not installed. Release notes are shown as plain text (`textContent`), tags and entities stripped. The update window has its own three-call bridge, given to it alone.
- **The self-test override** of Oerba's address needs both an unpackaged app and an explicit `--selftest` flag, and accepts only a loopback `http` origin.
- **The app holds no secret** and names no address that is not public.

To report a problem, open a private security advisory on this repository on GitHub.
