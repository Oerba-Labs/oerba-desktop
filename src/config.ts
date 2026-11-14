/* What the app is told when it starts. The one thing that can move Oerba's address is the self-test below, and it is
   honoured only by an app that is not packaged, given the explicit --selftest flag, and only for a loopback address. */

export const OERBA_ORIGIN = "https://app.oerba.dev";
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

export interface Config {
  oerbaOrigin: string;
  selftest: boolean;
  /** Self-test only: a second loopback origin standing in for "a page of another site". */
  otherOrigin: string | null;
  /** How often the setup screen asks Oerba again. */
  pollMs: number;
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/;

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

export function configFrom(argv: readonly string[], isPackaged: boolean): Config {
  const config: Config = { oerbaOrigin: OERBA_ORIGIN, selftest: false, otherOrigin: null, pollMs: 30_000 };
  // Both conditions, every time: a packaged app ignores every one of these flags, whatever it is given.
  if (isPackaged || !argv.includes("--selftest")) return config;
  config.selftest = true;
  const oerba = flag(argv, "oerba-origin");
  if (oerba !== null && LOOPBACK.test(oerba)) config.oerbaOrigin = oerba;
  const other = flag(argv, "other-origin");
  if (other !== null && LOOPBACK.test(other)) config.otherOrigin = other;
  const poll = Number(flag(argv, "poll-ms"));
  if (Number.isInteger(poll) && poll >= 50 && poll <= 30_000) config.pollMs = poll;
  return config;
}
