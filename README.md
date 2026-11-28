# Oerba Desktop

A Mac app for Oerba. It is a hardened Electron window that opens on a **setup screen**, walks a person through what is
needed to reach Oerba, and then shows Oerba's live pages at `https://app.oerba.dev/`.

Anyone may download it. Having it reaches nothing: Oerba answers only to people it has been shared with, over
Tailscale, and the app's job is to say which of those steps is still missing.

## What it does (stage 1)

On opening, the setup screen runs read-only checks and ticks each one when it sees it done, with what to do next beside the
first that is not:

1. **Tailscale installed**: looks for `/Applications/Tailscale.app`; if absent, a button opens Tailscale's download page in the browser.
2. **Signed in to Tailscale**: reads Tailscale's state with `tailscale status --json` and keeps only its backend state. If that cannot be read, the screen says so and judges by step 3.
3. **Invited to Oerba**: asks `https://app.oerba.dev/api/who` from the main process. Any proper answer means Oerba has been shared with the person; no answer means asking whoever sent them the app.
4. **Your name** and 5. **Access asked for and approved**: read from the same answer. The person does these in Oerba's own welcome page, so once Oerba answers the app loads it, and the setup screen only says what Oerba will ask.
6. **In**: Oerba's pages load in the window.

While the setup screen is open it asks Oerba again every 30 seconds, so an invitation accepted in Tailscale lets the person in without reopening the app.

## The menu bar, notifications and the dock (stage 3)

Once the person is in, the app stays in the menu bar. Closing the window only hides it; Quit (menu bar item or ⌘Q) ends the app.

- **Reads** `GET /api/now` and `GET /api/who` from the main process every 60 seconds, every 20 while the window is shown. Nothing is asked during setup.
- **The menu**: Open Oerba; Workspaces (your started ones, each opening its page); Waiting on you (n), the platform owner's alone; New chat; Switch workspace…; Open at login (a checkbox that changes the login item only when you tick it); Quit.
- **Notifications**, quiet on success: only when something newly waits on the owner, a deploy fails, or one of your workspaces fails. Not on the first read after the app starts, at most five a minute with the rest folded into "and n more". Clicking one opens the window at the right page.
- **The dock badge** counts what waits on the platform owner, and is empty for anyone else.
- **Global shortcuts**: ⌥Space shows the window and opens Oerba's own palette (it sends ⌘K to Oerba's page, which toggles it); ⌥⇧Space opens a new chat. Each is taken only if no other app holds it, and the menu says so if one is held.

All of it only reports and opens pages: nothing here deploys, starts, stops or changes anything. Every word from Oerba is cut to length and reduced to plain printable characters before it reaches a menu or a notification.

## A workspace's ports on localhost (0.4.0)

In the menu bar item, each of your started workspaces has a submenu: **Open in Oerba**, then its ports. **Open on localhost:8081** starts a forward: the app listens on `127.0.0.1` and `::1` on that number and relays HTTP and websockets to the same port of the workspace, so `http://localhost:8081` on the Mac is the workspace's port 8081. If the number is already taken on the Mac (by another program, or another forward) the next free one is used, and the menu shows it: **localhost:8082 → 8081 (stop)**. Starting a forward of a web port (3000, 5173, 8000 or 8080) opens `http://localhost:<the number it took>/` in your browser; Metro's and Expo's ports (8081, 19000, 19006) show a notification saying where it is instead, since the Simulator reads them; and one that cannot start says why. The Dock icon carries the same menu (Open Oerba, your workspaces and their forwards, New chat), for a Mac whose notch hides the menu bar item. A forward stops when you press that item, when its workspace is no longer started, and when the app quits. Since 0.6.0 the ports offered are the ones the workspace is listening on, as On-Demand's agent in it reports them (read as you, every time the menu bar item reads Oerba, and only the numbers are kept), less databases' ports and, since 0.6.1, the range 32768 to 60999, where the workspace's own tools (OpenCode, the editor) listen. Until On-Demand has answered for a workspace, or if it cannot be reached, the menu offers the usual dev servers' ports instead: 3000, 5173, 8000, 8080, 8081, 19000 and 19006. The workspace's agent must be named `main`, as both of the lab's templates name it; a workspace from a template that names it otherwise is not reached.

You need to be on the tailnet as for Oerba itself; the relay holds no credential and asks On-Demand as you.

**React Native and Expo.** Run Metro in the workspace (`npx expo start` or `npx react-native start`, port 8081 or 19000) and start its forward from the menu. Then, in the iOS Simulator on this Mac, open the development build and give it `localhost:8081` (Expo's "Enter URL manually", or `exp://localhost:8081`). Expo hands the app its bundle's address in a manifest, built from the request it answered. The relay sends a `Forwarded` header of its own naming the address the app asked, such as `proto=http;host="localhost:8081"`, and Expo's CLI reads it first from SDK 58 (August 2026; `resolveForwarded.ts` and `UrlCreator.ts` in `@expo/cli`, read on 24 Nov 2026, and seen working that day), so nothing need be set in the workspace. An older Expo reads only the `X-Forwarded-Proto: https` and the workspace's own name that On-Demand's front door adds, so its app is sent to an `https://` address the forward does not answer; `EXPO_PACKAGER_PROXY_URL` changes the host it names but not the scheme. Use Expo SDK 58 or later.

If the app still fetches its bundle from the workspace's long name or over `https`, the project's Expo is older than SDK 58: that name answers from this Mac too (tailnet), but without the relay's checks.

**Open in iOS Simulator (an Expo app).** On a workspace's Metro ports (8081 and 19000) the menu bar item and the Dock menu also offer **Open 8081 in iOS Simulator**. When Metro starts listening in one of your workspaces while Oerba is open, a notification offers the same: **demo's app is running**, *Open it on iPhone 17 Pro*, and a click opens it on that device, in the dev panel, in place of whatever the panel was showing. A click after Metro has stopped only says so. Each workspace has at most one such notification in five minutes. One press does the following, in order, and stops at the first thing that is missing:

1. Starts the forward of that port if it is not running, and uses the number it took.
2. Checks that Xcode is installed (read only). If not, it says so: install Xcode from the App Store, open it once and let it install the iOS platform. Oerba installs nothing.
3. Uses the simulator this workspace was last opened on, if this Mac still has it; otherwise an iPhone simulator that is already booted, or it boots the first iPhone of the newest iOS runtime.
4. Checks that Expo Go is in that simulator. If not, it says so: Expo's page for Expo Go offers a build for the iOS Simulator. Oerba installs nothing into it.
5. Opens `exp://127.0.0.1:<the number it took>` in Expo Go and says what it did.
6. Shows the phone in the dev panel at the right of Oerba's window, beside the page, which keeps the rest of the width. Click to tap, drag to swipe, and type when a field has the focus; serve-sim's own buttons under the phone reload the app's bundle, press Home, take a screenshot, reach the phone's clipboard and turn it, and its side buttons are the phone's own. The bar above the phone has the device's name, the workspace and port it shows (**demo · Metro 8081**), and **✕**, which closes the panel. If the panel cannot start, its bar says why.

**The Dev Panel button** (0.6.2) sits in a workspace's room in Oerba, beside OpenCode's, once Oerba draws it for this app (it reads `OerbaDesktop/<version>` in the app's User-Agent). Pressed, it opens that workspace's app in the panel when its Metro is running, and the panel alone otherwise; pressed again, it closes the panel. It shows as pressed while the panel is open. The panel opens at once, with a spinner and what is under way (*Starting iPhone 17 Pro…*), until the phone's picture has loaded, and says there why, if it cannot.

**The Dev Panel item** (0.6.1), in the menu bar item and the Dock menu, opens the panel on its own, with no app: on the device it last showed, if this Mac still has it, otherwise on a running iPhone, or it boots the first iPhone of the newest iOS runtime. The bar then says to start Metro in a workspace; once you do, the notification or the menu's **Open 8081 in iOS Simulator** opens the app on the device the panel shows. The item is ticked while the panel is open, and choosing it then closes the panel.

**Choosing the device.** The device's name in the bar is a button: it lists this Mac's simulators, the running ones first and then each iOS runtime's others, newest first, with the one shown ticked. Choosing one boots it if it is not running, opens the same app there, and moves the panel to it. Oerba remembers the device for that workspace (in a small file of its own, `devices.json` in its data folder), so the next press, or the notification when Metro starts, uses it when the panel is closed; while the panel is open, a press uses the device it shows. The list is read from Xcode's own `simctl` when you press the button; a page cannot name a device, and Oerba creates none: a device that is not listed is added in Xcode (Window, Devices and Simulators).

Start Expo in the workspace as usual (`npx expo start`); the project needs Expo SDK 58 or later, for the reason under *React Native and Expo* above.

**The panel** is Expo's [serve-sim](https://github.com/expo/serve-sim) 0.14.6, carried inside the app and run by it, changed in one place so that it does not open Device Hub when it starts, on this Mac's loopback alone and behind a token only the panel holds. While the panel is open it hands the simulator a small library of its own, which every app started in that simulator loads, and takes it out again when the panel closes, the window closes or Oerba quits. Its clipboard reader, network capture and camera injection are off or left out. Its clipboard button installs a small helper app of serve-sim's into the simulator the first time it copies, to read the simulator's clipboard. Its screenshot button and its logs' Download save nothing (Oerba refuses every download), nor does its logs' Copy reach the Mac's clipboard; Device Hub's own screenshot does. If taps do nothing in the panel after Device Hub was open, Device Hub may have left the simulator's input switched to itself, which lasts until that simulator reboots: reboot it (in Device Hub, or `xcrun simctl shutdown <name>` and press Open in iOS Simulator again).

Booting a simulator, the panel's library while it is open, the clipboard's helper app, and quitting Expo Go when you Forget Workspaces Allowed in Simulator are what this changes on the Mac. Oerba itself never erases, shuts down, creates or deletes a simulator; serve-sim's own controls in the panel can shut down or reboot the one it shows. Only the app's own menu, and Oerba's own Dev Panel button through the key the app gives Oerba's page alone, start it; no other page can. The packed app shows the panel only when it is in Applications.

**The workspace's code runs on this Mac.** An app in the iOS Simulator is a process of this Mac, running as you. A workspace's code in Expo Go there can read your Mac's files and send them anywhere: `probes/mac-files/` showed it on 28 Nov 2026 (`SECURITY.md`, *The dev panel*). So the app asks once for each workspace before its code first runs in the simulator, *Run demo's code on this Mac?*, and remembers your answer, by the workspace's name; **Forget Workspaces Allowed in Simulator**, in the menu bar item, lets every yes go, closes the panel and quits Expo Go, and each workspace is asked again. Open in the simulator only workspaces whose code you would run on this Mac yourself.

**A web dev server** (Vite, Next, webpack) on 3000, 5173 or 8080: forward it and open `http://localhost:5173`. A page on one forward may call another forward of the same workspace (a frontend on `localhost:5173` and an API on `localhost:8000`, both started from the menu); a page from a port the app is not forwarding, or from another site, may not (see `SECURITY.md`). A server that checks the `Host` it sees (Vite's `server.allowedHosts`) sees the workspace's name, not `localhost`: allow it there. Your app's own cookies pass both ways once the workspace has set them (a `Domain` on one is removed so it lands on localhost); other programs' cookies on localhost, and On-Demand's own, are never sent on. A link to a forward from another website shows the relay's own "Opened from another site" page first, with a Continue link. **An app's own `Authorization: Bearer` cannot pass through On-Demand's proxy**, by the relay or by the browser's door at the workspace's name alike, because On-Demand reads a Bearer as its own credential: while a dev app is served this way it should use a cookie or another header. The relay drops `Authorization`.

## What it does not do

- It **deploys nothing** and has no way to.
- It **holds no secret**: no token, key or password, and no address that is not public. A forward carries no credential either: On-Demand knows you by the tailnet address.
- It **changes nothing on the computer** in setup: it never runs Tailscale's `up`, `login`, `set` or anything else that changes it, installs nothing and signs nobody in. The download button only opens a web page.
- It gives remote pages **no bridge** to the app, the computer or any device, lets only Oerba's own page (after a press, a few a minute) send a link to the browser, and cancels every download (see `SECURITY.md`).

## Build and run

Node 22 or newer, on a Mac. Every dependency is pinned to an exact version in `package-lock.json`.

```sh
npm ci --ignore-scripts                    # installs exactly the locked packages, running none of their scripts
node node_modules/electron/install.js      # fetches Electron's binary alone; it checks the binary's published sum
npm run build                              # type-checks, then compiles with esbuild into dist/ (the development bundle, with the self-test)
npm start                                  # builds and opens the app
npm test                                   # builds, then runs the unit tests with node --test
npm run smoke                              # opens the real app against stand-in servers on loopback, and checks the shell
```

Do not run `npm install` to change versions: it rewrites the lockfile. To move a dependency, change its pinned version in
`package.json` and run `npm install --package-lock-only` once.

`npm run smoke` launches Electron with `--selftest`, which points the app at two stand-in servers on `127.0.0.1`. The
override is honoured only when the app is **not packaged** and `--selftest` is given, and only for a loopback `http` address
(`src/config.ts`, tested in `test/config.test.ts`); a packaged app ignores every such flag.

## Packing and releasing (stage 4)

`npm run pack:unsigned` builds the packaged bundle (`build/app/`, which holds no self-test, tests or scripts) and packs an **unsigned** `Oerba.app`, dmg and zip into `release/` for arm64. It signs nothing and sends nothing to Apple or GitHub (electron-builder does download its helper tools from GitHub, without credentials).
`npm run verify:pack` then reads the fuses back, searches `app.asar` for the self-test, and starts a scratch copy (signed ad hoc, since macOS kills an unsigned arm64 app) to see that it draws its setup screen and that a second launch only exits.

Releasing is the owner's, on the Mac that holds the signing identity (a "Developer ID Application" certificate) and a notarytool keychain profile named `oerba-notary`:

```sh
bash scripts/release.sh
```

The release's notes are written by hand in the repository, `release-notes/v<version>.md`, and committed with the version bump; the script refuses to start if the file for `package.json`'s version is missing or empty, and the printed command uses it as the release's notes. It refuses a dirty tree, a tag that exists, or a commit not on `origin/main`; installs and tests; packs, signs, notarises and staples the app with electron-builder; signs, notarises and staples the dmg too; rewrites `latest-mac.yml` to list the zip alone (stapling changed the dmg's bytes, and the Mac updater installs from the zip), checked against the zip on disk; stops unless `codesign`, `spctl` (app and dmg), `stapler validate` (app and dmg), the fuses read back and a search of the packed `app.asar` for the self-test all pass; and prints every file's SHA-256 (after stapling), `latest-mac.yml` and the next command. It publishes nothing. That command makes a **draft** GitHub release, to be read and published on GitHub:

```sh
gh release create v<version> \
  release/Oerba-<version>-arm64.dmg release/Oerba-<version>-arm64-mac.zip \
  release/Oerba-<version>-arm64-mac.zip.blockmap release/latest-mac.yml \
  --target <commit> --draft --title "Oerba Desktop <version>" --notes-file release-notes/v<version>.md
```

The package is arm64 only: every Mac Oerba's people use is Apple silicon, and a universal build would double a 125 MB download for none of them.

### Updates

A packaged app asks GitHub Releases for `latest-mac.yml` once the person is in, every hour, and when the Mac wakes. A newer version is downloaded at once and checked (it must be this app alone, at the version offered, newer than the one running), then handed to macOS's installer, which checks its signature; once the installer has taken it, the next quit of the app, for any reason, installs it. Once it is ready, a notification says so, and the menu bar item offers **Restart to Update to <version>**; "Update to <version>…" opens a small window of the app's own with the release's notes (shown as plain text), the download's progress and **Restart now**. If the person has not restarted a day after the update was ready, the app restarts itself the next time the Mac has had no input for seven minutes or its screen is locked, and the dev panel is closed. An unpackaged run never looks. A downgrade or a prerelease is never taken, and a version that fails a check is not fetched again by itself for a day. The feed is fixed by the build (`publish` in `electron-builder.yml`); nothing in the app, on the command line or from a page can change it.

## Layout

- `src/policy/`: the shell's rules as small pure modules (navigation, permissions, external links), tested without Electron.
- `src/setup/`: what the setup screen checks (`probes.ts`), how it reads `/api/who` (`who.ts`) and how the steps follow from it (`state.ts`).
- `src/present/`: the menu bar, notifications and badge: reading `/api/now` (`now.ts`), what is worth a notification (`notify.ts`), the menu as data (`menu.ts`), routes (`routes.ts`), plain text (`text.ts`), a workspace's listening ports and when Metro starting earns an offer (`ports.ts`), and `presence.ts` wiring them to Electron.
- `src/sim/`: opening a Metro port in the iOS Simulator: the decisions as pure functions (`decide.ts`), the one-press-at-a-time runner of Xcode's tools (`run.ts`), and the device each workspace was last opened on (`remember.ts`); the dev panel's rules for serve-sim (`serve.ts`), the process that runs it (`server.ts`) and the panel's views (`panel.ts`), whose bar is `static/simbar.*`, `src/renderer/simbar.ts` and `src/preload-simbar.ts`. `scripts/stage-serve-sim.mjs` says which parts of serve-sim the packed app carries.
- `src/relay/`: the localhost forwards: the rules as pure functions (`rules.ts`), one forward's listeners (`forward.ts`) and the running ones (`manager.ts`).
- `src/update/`: when to check, the update state, release notes as plain text, and the window.
- `src/shell/hardening.ts`: wires the policies to Electron. `src/main.ts`: the window. `src/preload-setup.ts`: the setup page's three calls.
- `static/`, `src/renderer/`: the setup screen's HTML, CSS (Oerba's Quiet Slate) and TypeScript.

## Stages

Stage 1 was the shell and the setup screen; stage 3 the menu bar item, notifications, dock badge and shortcuts; stage 4 packing, signing, notarising and updates that ask; stage 5 (0.4.0) a workspace's ports on the Mac's localhost; 0.4.2 opened an Expo app in the iOS Simulator, and 0.5.0 shows the phone beside Oerba's page. Later: every workspace's pages kept open side by side, reaching the computer (folders, and ports other than HTTP), a tab of Oerba's page for the phone on the same engine, and Flutter and Swift. Each is its own stage.

## Licence

All rights reserved (`LICENSE`). The source is published so that anyone can read what the app does on their computer; it is
not licensed for reuse. Oerba Labs' signed releases may be run as they are.

The app carries others' code under their own licences, each with its licence file beside it in `Oerba.app/Contents/Resources/serve-sim`:
Expo's serve-sim (Apache-2.0, with its `NOTICE`; its command, `dist/serve-sim.js`, is changed by Oerba Labs as its head says), ws (MIT), and the WebRTC framework serve-sim links (BSD-style, `LICENSE.webrtc`).
