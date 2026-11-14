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

In the menu bar item, each of your started workspaces has a submenu: **Open in Oerba**, then its ports. **Open on localhost:8081** starts a forward: the app listens on `127.0.0.1` and `::1` on that number and relays HTTP and websockets to the same port of the workspace, so `http://localhost:8081` on the Mac is the workspace's port 8081. If the number is already taken on the Mac (by another program, or another forward) the next free one is used, and the menu shows it: **localhost:8082 → 8081 (stop)**. A forward stops when you press that item, when its workspace is no longer started, and when the app quits. The ports offered are 3000, 5173, 8000, 8080, 8081, 19000 and 19006: Oerba's page does not say which ports a workspace is listening on, so the list is a fixed one of the usual dev servers. The workspace's agent must be named `main`, as both of the lab's templates name it; a workspace from a template that names it otherwise is not reached.

You need to be on the tailnet as for Oerba itself; the relay holds no credential and asks On-Demand as you.

**React Native and Expo.** Run Metro in the workspace (`npx expo start` or `npx react-native start`, port 8081 or 19000) and start its forward from the menu. Then, in the iOS Simulator on this Mac, open the development build and give it `localhost:8081` (Expo's "Enter URL manually", or `exp://localhost:8081`). Metro builds the bundle URLs it hands out from the address it was asked on, which On-Demand's proxy has changed to the workspace's own name, so start it with the address you want the app to use:

```sh
REACT_NATIVE_PACKAGER_HOSTNAME=localhost npx expo start        # or: EXPO_PACKAGER_PROXY_URL=http://localhost:8081 npx expo start
```

If the app still fetches its bundle from the workspace's long name, the forward is not the problem: that name answers from this Mac too (tailnet), but without the relay's checks. Use the forward's number: if it fell to 8082, use `http://localhost:8082` and `EXPO_PACKAGER_PROXY_URL` to match.

**A web dev server** (Vite, Next, webpack) on 3000, 5173 or 8080: forward it and open `http://localhost:5173`. A page on one forward may call another forward (a frontend on `localhost:5173` and an API on `localhost:8000`, both started from the menu); a page from a port the app is not forwarding, or from another site, may not (see `SECURITY.md`). A server that checks the `Host` it sees (Vite's `server.allowedHosts`) sees the workspace's name, not `localhost`: allow it there. Your app's own cookies pass both ways (a `Domain` on one is removed so it lands on localhost); On-Demand's own are never sent on. **An app's own `Authorization: Bearer` cannot pass through On-Demand's proxy**, by the relay or by the browser's door at the workspace's name alike, because On-Demand reads a Bearer as its own credential: while a dev app is served this way it should use a cookie or another header. The relay drops `Authorization`.

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

A packaged app asks GitHub Releases for `latest-mac.yml` once the person is in, and every six hours. It never downloads or installs by itself. When a newer version is found, the menu bar item gains "Update to <version>…", which opens a small window of the app's own with the release's notes (shown as plain text) and two buttons: **Download**, and, once downloaded, **Restart now**; **Later** closes it. Nothing is installed until Restart now is pressed. An unpackaged run never looks. The feed is fixed by the build (`publish` in `electron-builder.yml`); nothing in the app, on the command line or from a page can change it.

## Layout

- `src/policy/`: the shell's rules as small pure modules (navigation, permissions, external links), tested without Electron.
- `src/setup/`: what the setup screen checks (`probes.ts`), how it reads `/api/who` (`who.ts`) and how the steps follow from it (`state.ts`).
- `src/present/`: the menu bar, notifications and badge: reading `/api/now` (`now.ts`), what is worth a notification (`notify.ts`), the menu as data (`menu.ts`), routes (`routes.ts`), plain text (`text.ts`), and `presence.ts` wiring them to Electron.
- `src/relay/`: the localhost forwards: the rules as pure functions (`rules.ts`), one forward's listeners (`forward.ts`) and the running ones (`manager.ts`).
- `src/update/`: when to check, the update state, release notes as plain text, and the window.
- `src/shell/hardening.ts`: wires the policies to Electron. `src/main.ts`: the window. `src/preload-setup.ts`: the setup page's three calls.
- `static/`, `src/renderer/`: the setup screen's HTML, CSS (Oerba's Quiet Slate) and TypeScript.

## Stages

Stage 1 was the shell and the setup screen; stage 3 the menu bar item, notifications, dock badge and shortcuts; stage 4 packing, signing, notarising and updates that ask; stage 5 (this version, 0.4.0) a workspace's ports on the Mac's localhost. Later: every workspace's pages kept open side by side, reaching the computer (folders, and ports other than HTTP), and simulators. Each is its own stage.

## Licence

All rights reserved (`LICENSE`). The source is published so that anyone can read what the app does on their computer; it is
not licensed for reuse. Oerba Labs' signed releases may be run as they are.
