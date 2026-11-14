/* Reading /api/who. Only keys of console/clients.json's contract for Oerba Desktop are relied on for the name
   (`handle`, `github`); `known`, `person` and `may_act` are read as hints, and absent or odd values count as unknown. */

export interface Who {
  handle: string;
  github: string;
  known: boolean | null;
  person: string | null;
  mayAct: boolean | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function readWho(body: unknown): Who | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const person = str(b["person"]);
  return { handle: str(b["handle"]), github: str(b["github"]), known: bool(b["known"]), person: person || null, mayAct: bool(b["may_act"]) };
}

export const hasHandle = (w: Who): boolean => w.handle !== "";

/** Whether the platform's owner has given them access: they may act, or the console calls them an owner, member or
    given reader. "nobody", "suspended" and anything unknown are not approved. */
export function approved(w: Who): boolean {
  if (w.mayAct === true) return true;
  return w.person === "owner" || w.person === "member" || w.person === "given";
}
