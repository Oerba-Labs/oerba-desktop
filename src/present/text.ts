/* Words that came from a machine, made safe before they reach a menu, a notification or a route. Pure. */

/** Letters, marks, numbers, punctuation, symbols and ordinary spaces. Control, format (including bidirectional), private-use,
    unassigned and line-separator characters are none of these, so they never reach a native surface. */
const PRINTABLE = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu;

/** One line of plain printable text, at most `max` characters (counting code points), cut with an ellipsis. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFC").replace(PRINTABLE, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/** A name safe to put in an address: letters, digits and . _ - @ inside, starting with a letter or digit, at most 64. */
export const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}(?![\s\S])/;

export const plainName = (value: unknown): string | null => (typeof value === "string" && PLAIN_NAME.test(value) ? value : null);
