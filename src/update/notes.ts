/* Release notes as plain text. electron-updater may hand over HTML (GitHub renders release notes to it); nothing of it is
   ever set as HTML. The text is stripped of tags, entities are decoded, control and bidirectional characters are dropped,
   and the length is capped; the window sets the result with textContent. Pure. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };
const NOT_PLAIN = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\n]/gu;

export function notesToText(raw: unknown, max = 3000): string {
  let notes = "";
  if (typeof raw === "string") notes = raw;
  else if (Array.isArray(raw)) notes = raw.map((r) => (typeof r === "object" && r !== null && typeof (r as { note?: unknown }).note === "string" ? (r as { note: string }).note : "")).join("\n");
  if (notes.length > 100_000) notes = notes.slice(0, 100_000);
  const text = notes
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/ul|\/ol)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\r\n?/g, "\n")
    .replace(NOT_PLAIN, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max - 1).join("").trimEnd() + "…";
}
