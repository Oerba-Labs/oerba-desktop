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
  /** Self-test only: how often the menu bar item reads /api/now. */
  presentMs: number | null;
  /** Self-test only: a loopback http address the localhost relay dials in place of On-Demand's names (src/relay/rules.ts). */
  relayUpstream: string | null;
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/;

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

export function configFrom(argv: readonly string[], isPackaged: boolean): Config {
  const config: Config = { oerbaOrigin: OERBA_ORIGIN, selftest: false, otherOrigin: null, pollMs: 30_000, presentMs: null, relayUpstream: null };
  // Both conditions, every time: a packaged app ignores every one of these flags, whatever it is given.
  // And in the packaged build the self-test is compiled out (__SELFTEST__ is false there), so these flags are not even in the code.
  if (!__SELFTEST__ || isPackaged || !argv.includes("--selftest")) return config;
  config.selftest = true;
  const oerba = flag(argv, "oerba-origin");
  if (oerba !== null && LOOPBACK.test(oerba)) config.oerbaOrigin = oerba;
  const other = flag(argv, "other-origin");
  if (other !== null && LOOPBACK.test(other)) config.otherOrigin = other;
  const poll = Number(flag(argv, "poll-ms"));
  if (Number.isInteger(poll) && poll >= 50 && poll <= 30_000) config.pollMs = poll;
  const present = Number(flag(argv, "present-ms"));
  if (Number.isInteger(present) && present >= 50 && present <= 60_000) config.presentMs = present;
  const relay = flag(argv, "relay-upstream");
  if (relay !== null && LOOPBACK.test(relay)) config.relayUpstream = relay;
  return config;
}
