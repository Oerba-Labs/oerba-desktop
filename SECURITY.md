# The shell's rules

Oerba's pages are not trusted with the computer. The window they run in is built so that a page that went wrong, or a link that
leads somewhere it should not, finds nothing to reach. The rules are in `src/policy/` and tested without Electron; `src/shell/hardening.ts`
only wires them in.

- **Settings of every view:** `contextIsolation` on, `sandbox` on, no `nodeIntegration` (also not in workers or subframes), no `webviewTag`
  (a `<webview>` attach is refused), `webSecurity` on, no insecure content.
- **No bridge for remote pages.** No preload is given to Oerba's view or to any page but the app's own two, the bundled setup screen and the update window. The setup preload exposes
  three calls (`getState`, `onState`, `act`), and the update window's own preload three (`getState`, `onState`, `act`), through `contextBridge`. Each does nothing unless it runs in its own page's top frame,
  and the main process checks the sender's frame again on every message.
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
- **The localhost relay** (0.4.0, `src/relay/`). A forward is started only by the person, from the menu, for one of their own started workspaces and a port from a fixed list, and relays HTTP and websockets to `<port>--main--<workspace>--<owner>.ondemand.oerba.dev`.
  - *It listens* on `127.0.0.1` and `::1`, one number on both, and on no other address; a number another program already answers on, on either address, is skipped (binding beside another program's wildcard listener can succeed on macOS and would hide that program). It stops with its workspace (read from the poll of `/api/now`), when the person stops it, and when the app quits. At most sixteen at once.
  - *It dials* only a name built from a port of four or five digits (1024 to 65535), a workspace and an owner each matching letters and digits with single hyphens inside (On-Demand's own name pattern), with the agent named `main` between port and workspace (On-Demand refuses a port's name with no agent; both of the lab's templates name theirs `main`, and `/api/now` does not say, so a template whose agent is named otherwise is not reached), at most 63 characters together, ending `.ondemand.oerba.dev`, over TLS on 443 with the certificate verified and the name as SNI and `Host`. Nothing from a request chooses the name or the address (a request target must be a path: an absolute address, `*` and `//` are refused).
  - *It refuses* a request whose `Host` is not `localhost:<n>`, `127.0.0.1:<n>` or `[::1]:<n>` for its own number (DNS rebinding: a page at another name that was made to resolve to `127.0.0.1`), with 421; one whose `Origin` is present and is not `http://localhost:<n>`, `http://127.0.0.1:<n>` or `http://[::1]:<n>`, with 403, except that the `Origin` of another forward this app is running now (a page on `localhost:5173` calling an API on `localhost:8000`) passes, and so does `Sec-Fetch-Site: same-site` with such an `Origin`; and one with `Sec-Fetch-Site` of anything but none, `same-origin` or absent unless it is a top-level `GET` or `HEAD` navigation to a document, with 403 (On-Demand's own rule for when it believes a tailnet identity, `identityAllowedFor`). A websocket upgrade passes the same three checks before anything is dialled. A page on a localhost port the app is not forwarding cannot call a forward.
  - *It never sends on* `Origin`, `Sec-Fetch-*`, `Authorization` and `Proxy-Authorization`, On-Demand's `On-Demand-Session-Token` header, the query parameters `ondemand_session_token` and `access_token`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Tailscale-User-*`, `Referer`, `Expect` and the hop-by-hop headers, with any header the `Connection` header names. It holds no credential of its own. `Authorization` and the two parameters are cut because On-Demand reads any of them as an explicit session token and then does not apply the person's tailnet identity (`hasExplicitToken`), so one would only break the request. `Cookie` is sent without On-Demand's own cookies (`ondemand_session_token`, `oauth_state`, `oauth_redirect`, `ondemand_path_app_session_token`, `ondemand_signed_app_token` and any `ondemand_subdomain_app_session_token…`, the names `StripOnDemandCookies` drops); the app's own cookies pass, since the cookies of every localhost port are one jar and both ends are the person's own. `Set-Cookie` comes back with any `Domain` attribute removed (so it lands on localhost) and without On-Demand's names. Responses are streamed, and a redirect to the app's own name is turned back to the forward's address.
  - *What it does not guard against.* Every program on the Mac, and the person's own browser at the app's name, already reaches those names as the person, because the tailnet address is theirs and On-Demand takes the identity from it for any request that is not another site's web page. The relay therefore gives local programs nothing new; its checks are against web pages in a browser, which could otherwise use a forward to read or write a workspace's dev server as the person. Programs that can set `Host` and `Origin` as they like (curl, a script) pass its checks, by design.
  - *The self-test* may point the relay at a loopback `http` stand-in (`--relay-upstream`, an unpackaged app given `--selftest`, loopback only); a packaged app has no such flag, and `loopbackUpstream` accepts nothing but a loopback address.
  - Not done here: ports other than HTTP and websockets (a database, a debugger), which would hold an On-Demand session token and are a stage of their own.
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
  into the app as `app-update.yml`; the app never calls `setFeedURL`, and nothing from a page or the command line reaches it. What refuses a forged update is **TLS to GitHub** (the feed and the zip are fetched
  over it) and **Squirrel.Mac**, which installs a new app only if its code signature satisfies the running app's own requirement (signed by the same team's Developer ID). The SHA-512 in `latest-mac.yml`
  guards against a corrupt or truncated download only: it comes from the same place as the zip, so it proves nothing about who made it. Release notes are shown as plain text (`textContent`), tags and entities stripped.
  The update window has its own three-call bridge, given to it alone.
- **Packing downloads tools, and uploads nothing.** `npm run pack:unsigned` (and the release build) makes electron-builder fetch its helper tools (icons, 7zip, dmgbuild) from GitHub, without any credential;
  it sends nothing anywhere. Only `scripts/release.sh` talks to Apple, by notarytool, for the owner's own build.
- **The self-test override** of Oerba's address needs both an unpackaged app and an explicit `--selftest` flag, and accepts only a loopback `http` origin.
- **The app holds no secret** and names no address that is not public.

To report a problem, open a private security advisory on this repository on GitHub.
