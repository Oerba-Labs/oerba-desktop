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
- **The self-test override** of Oerba's address needs both an unpackaged app and an explicit `--selftest` flag, and accepts only a loopback `http` origin.
- **The app holds no secret** and names no address that is not public.

To report a problem, open a private security advisory on this repository on GitHub.
