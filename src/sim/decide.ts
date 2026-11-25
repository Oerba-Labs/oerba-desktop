/* Opening a workspace's Metro port in the iOS Simulator: what is read from `simctl`, which device is used, the address that is
   opened and what the person is told. Pure: nothing here runs a program (src/sim/run.ts does), so a test can read every decision.
   Nothing a workspace, Oerba's API or a page said reaches any of it; the only inputs are what `simctl` printed on this Mac and the
   number a forward of the app's own took. */

/** The workspace ports that are Metro's: only these are offered "Open in iOS Simulator" (the web ports and 19006's web page are not). */
export const METRO_PORTS: readonly number[] = [8081, 19000];

/** Expo Go's bundle identifier, the same for every iOS build of it. */
export const EXPO_GO = "host.exp.Exponent";

export interface Device { udid: string; name: string; booted: boolean; iphone: boolean; runtime: readonly number[] }

/** The shape of a UUID, upper or lower case, and nothing else (no whitespace, no newline, nothing after it). */
export const isUdid = (v: unknown): v is string => typeof v === "string" && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![\s\S])/.test(v);

/** A port as an integer from 1 to 65535: the number the app's own forward took. */
export const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/** The address Expo Go is asked to open, built from the port alone; null for anything that is not a port. */
export const expoUrl = (port: unknown): string | null => (isPort(port) ? `exp://127.0.0.1:${port}` : null);

/** Xcode 27's Device Hub (it replaced Simulator.app) and Simulator on Xcode 26 and earlier, each found by bundle id: never by name,
    and never by the address's scheme alone, since any app can register `devices:`. A bundle id is not proof that the app is Apple's
    (a copy claiming it could be placed by a program running as the person); what it is handed is a UUID. */
export const DEVICE_HUB_ID = "com.apple.dt.Devices";
export const SIMULATOR_ID = "com.apple.iphonesimulator";

/** The deep link that shows a device in Device Hub, built from a UUID-shaped UDID alone; null for anything else. */
export const deviceHubUrl = (udid: unknown): string | null => (isUdid(udid) ? `devices://device/open?id=${udid}` : null);

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` is iOS 26.5, [26, 5]. Other platforms' runtimes (tvOS, watchOS, visionOS) are null. */
export function iosVersion(runtime: string): number[] | null {
  const m = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-([0-9]{1,3})(?:-([0-9]{1,3}))?(?:-([0-9]{1,3}))?(?![\s\S])/.exec(runtime);
  return m ? [m[1], m[2] ?? "0", m[3] ?? "0"].map(Number) : null;
}

const newer = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
};

/** The available iOS devices of `simctl list devices --json`, in the order it lists them; [] for anything that is not that. A device
    whose UDID is not a UUID is left out, so no later step can be handed one. */
export function parseDevices(text: string): Device[] {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return []; }
  const groups = typeof root === "object" && root !== null ? (root as { devices?: unknown }).devices : null;
  if (typeof groups !== "object" || groups === null || Array.isArray(groups)) return [];
  const out: Device[] = [];
  for (const [runtime, list] of Object.entries(groups)) {
    const version = iosVersion(runtime);
    if (version === null || !Array.isArray(list)) continue;
    for (const d of list as unknown[]) {
      if (typeof d !== "object" || d === null) continue;
      const o = d as Record<string, unknown>;
      if (o["isAvailable"] !== true || !isUdid(o["udid"])) continue;
      const type = typeof o["deviceTypeIdentifier"] === "string" ? o["deviceTypeIdentifier"] : "";
      out.push({ udid: o["udid"], name: typeof o["name"] === "string" ? o["name"] : "", booted: o["state"] === "Booted", iphone: type.startsWith("com.apple.CoreSimulator.SimDeviceType.iPhone"), runtime: version });
    }
  }
  return out;
}

export type Pick = { kind: "booted"; device: Device } | { kind: "boot"; device: Device } | { kind: "none" };

/** A booted iOS device if there is one (an iPhone before any other, then the newest runtime's); else the first iPhone of the newest
    iOS runtime that has one, to be booted; else none. */
export function pickDevice(devices: readonly Device[]): Pick {
  const best = (list: readonly Device[]): Device | undefined => list.reduce<Device | undefined>((b, d) => (b === undefined || newer(d.runtime, b.runtime) ? d : b), undefined);
  const booted = devices.filter((d) => d.booted);
  const up = best(booted.filter((d) => d.iphone)) ?? best(booted);
  if (up) return { kind: "booted", device: up };
  const fresh = best(devices.filter((d) => d.iphone));
  if (!fresh) return { kind: "none" };
  // The first of that runtime, in the order simctl lists them.
  const first = devices.find((d) => d.iphone && d.runtime.join(".") === fresh.runtime.join("."));
  return { kind: "boot", device: first ?? fresh };
}

/** How one press ended. */
export type Outcome =
  | { kind: "opened"; name: string; booted: boolean; port: number; shown: boolean }
  | { kind: "no-xcode" }
  | { kind: "no-iphone" }
  | { kind: "boot-failed" }
  | { kind: "no-expo-go"; name: string }
  | { kind: "open-failed"; name: string }
  | { kind: "failed" };

export interface Say { title: string; body: string }

/** What the person is told, from what was found. A name is a simulator's own ("iPhone 18 Pro") and is cut by the caller's `clean`. */
export function describe(o: Outcome): Say {
  switch (o.kind) {
    case "opened": return { title: "Oerba", body: `${o.booted ? "Booted" : "Used"} ${o.name} and opened exp://127.0.0.1:${o.port} in Expo Go${o.shown ? "" : ". the window could not be shown: open Device Hub (Simulator on Xcode 26 and earlier) yourself"}` };
    case "no-xcode": return { title: "Xcode is needed for the Simulator", body: "Install Xcode from the App Store, open it once and let it install the iOS platform. Oerba installs nothing itself." };
    case "no-iphone": return { title: "No iPhone simulator", body: "Xcode has no iPhone simulator yet: open Xcode, then Settings, Components, and install the iOS platform." };
    case "boot-failed": return { title: "The Simulator did not start", body: "An iPhone simulator would not boot. Open Simulator yourself and try again." };
    case "no-expo-go": return { title: "Expo Go is not in the Simulator", body: `Not in ${o.name}. Expo's page for Expo Go offers a build for the iOS Simulator: install it there, then press again.` };
    case "open-failed": return { title: "Expo Go would not open it", body: `${o.name} refused the address. Is Metro running in the workspace?` };
    case "failed": return { title: "The Simulator could not be used", body: "Something went wrong asking Xcode. Try again, or open Simulator yourself." };
  }
}

/** The one-off note after a first success. Expo builds the bundle's address from the relay's own `Forwarded` header from SDK 58; an
    older Expo takes the scheme from the `X-Forwarded-Proto: https` the front door adds, and no setting of its own changes that
    (`EXPO_PACKAGER_PROXY_URL` sets the host but not the scheme, 24 Nov 2026), so its app asks the forward for TLS it does not speak. */
export const expoHint = (): Say => ({ title: "Expo SDK 58 or later", body: "The forward tells Expo the phone's address, which Expo reads from SDK 58. An older project's app is sent to an https address and cannot load." });
