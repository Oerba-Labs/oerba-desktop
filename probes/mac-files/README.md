# Can an app in the iOS Simulator read the Mac's files?

An app in the iOS Simulator is a process of the Mac, running as you, with no macOS sandbox of its own. Open in iOS Simulator and
the dev panel run a workspace's JavaScript there, in Expo Go. Whether that code could read the Mac's files was not settled
until this probe ran on 28 Nov 2026, from a workspace in Oerba Desktop 0.6.2's panel: it can. Every attempt below read, by all
three ways, and both listings answered (`SECURITY.md`, *The dev panel*). So a workspace's code there can read your files at
known paths, and could read serve-sim's state file, which holds the panel's token, by walking to the per-user temporary
folder. That is why 0.6.3 asks once for each workspace before its code first runs there, and why no agent may open or drive
the iOS Simulator. Run it again when Expo Go moves to a new SDK.

`App.js` here settles it. It tries to read `/etc/hosts` and a file you make for the test, by `fetch`, by `XMLHttpRequest` and by
`expo-file-system`. It also asks whether it can list your home folder and `/var/folders`. It shows a length or a count for
each, never what it read, except the words of the file made for the test. It sends nothing anywhere. It is not part of the
app, and is not packed into it.

## Running it

1. **On the Mac**, make the file the probe looks for:
   ```
   echo oerba-probe > ~/oerba-probe.txt
   ```
2. **In a workspace** whose Expo app already opens in the panel, stop its Metro (Ctrl+C), then:
   ```
   cd /tmp
   npx create-expo-app@latest mac-files-probe --template blank
   cd mac-files-probe
   npx expo install expo-file-system
   curl -fsSL https://raw.githubusercontent.com/Oerba-Labs/oerba-desktop/main/probes/mac-files/App.js -o App.js
   npx expo start --port 8081
   ```
   This makes a blank Expo project, swaps in this probe, and starts Metro where the panel looks for it. If the panel later
   says the project's SDK is not the one Expo Go has, make it again with `--template blank@sdk-<N>`, `<N>` being the SDK
   of the workspace's own project.
3. **In Oerba**, open that workspace's room and press **Dev Panel**. The probe opens on the phone and lists each attempt. A
   line in red says something was READ.
4. Copy the lines down: a screenshot of the panel, or Metro's `[mac-files]` lines in the workspace's terminal.
5. Clean up. On the Mac, `rm ~/oerba-probe.txt`. In the workspace, Ctrl+C Metro and `rm -rf /tmp/mac-files-probe`, and
   start the project's own Metro again.

## Reading what it says

- **Every line says refused**, and the first says the app's folder is under the home: Expo Go keeps a workspace's code to
  its own folder, by every way tried. The question is settled for this Expo Go. Ask again when Expo Go moves to a new SDK.
- **Any line says READ**: the code can reach your files. Until that is answered, open in the simulator only workspaces whose
  code you would run on the Mac yourself, and no agent may open or drive the device on iOS.
