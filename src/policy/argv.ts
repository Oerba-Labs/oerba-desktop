/* A packaged app starts only as it is normally opened. Chromium and Electron take switches from the command line
   (--inspect, --remote-debugging-port, --no-sandbox, --disable-web-security ...); a launcher that passes one is
   trying to loosen the shell, and the app refuses to start rather than run loosened. */

/** Finder's own process serial number on older macOS: the one switch a normal launch may carry. (`(?![\s\S])` is the
    end of the text, where `$` would let a trailing newline through.) */
const ALLOWED = [/^-psn_[0-9]+_[0-9]+(?![\s\S])/];

/** The switches among the arguments (everything after the program's own name) that a normal launch does not carry. */
export function unexpectedSwitches(args: readonly string[]): string[] {
  return args.filter((a) => a.startsWith("-") && !ALLOWED.some((re) => re.test(a)));
}
