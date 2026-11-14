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

## What it does not do

- It **deploys nothing** and has no way to.
- It **holds no secret**: no token, key or password, and no address that is not public.
- It **changes nothing on the computer** in setup: it never runs Tailscale's `up`, `login`, `set` or anything else that changes it, installs nothing and signs nobody in. The download button only opens a web page.
- It gives remote pages **no bridge** to the app, the computer or any device, lets only Oerba's own page (after a press, a few a minute) send a link to the browser, and cancels every download (see `SECURITY.md`).

## Build and run

Node 22 or newer, on a Mac. Every dependency is pinned to an exact version in `package-lock.json`.

```sh
npm ci --ignore-scripts                    # installs exactly the locked packages, running none of their scripts
node node_modules/electron/install.js      # fetches Electron's binary alone; it checks the binary's published sum
npm run build                              # type-checks, then compiles with esbuild into dist/
npm start                                  # builds and opens the app
npm test                                   # builds, then runs the unit tests with node --test
npm run smoke                              # opens the real app against stand-in servers on loopback, and checks the shell
```

Do not run `npm install` to change versions: it rewrites the lockfile. To move a dependency, change its pinned version in
`package.json` and run `npm install --package-lock-only` once.

`npm run smoke` launches Electron with `--selftest`, which points the app at two stand-in servers on `127.0.0.1`. The
override is honoured only when the app is **not packaged** and `--selftest` is given, and only for a loopback `http` address
(`src/config.ts`, tested in `test/config.test.ts`); a packaged app ignores every such flag.

## Layout

- `src/policy/`: the shell's rules as small pure modules (navigation, permissions, external links), tested without Electron.
- `src/setup/`: what the setup screen checks (`probes.ts`), how it reads `/api/who` (`who.ts`) and how the steps follow from it (`state.ts`).
- `src/shell/hardening.ts`: wires the policies to Electron. `src/main.ts`: the window. `src/preload-setup.ts`: the setup page's three calls.
- `static/`, `src/renderer/`: the setup screen's HTML, CSS (Oerba's Quiet Slate) and TypeScript.

## Stages to come

Stage 1 is this: the shell and the setup screen, unsigned. Later: packing, signing and notarising with electron-builder; an
updater that asks (electron-updater, with GitHub Releases); then every workspace's pages kept open side by side, the menu bar
item, reaching the computer (forwarded ports, folders), and simulators. Each is its own stage.
