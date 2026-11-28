/* A GET of a JSON object from Oerba or On-Demand, held to a timeout, no redirects, a size cap and an object or nothing, and sent with
   no credential of the session's (no cookie, no stored login): both know the person by their tailnet address alone. */

export interface PresentResponse { status: number; body: ReadableStream<Uint8Array> | null }
export type PresentFetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; credentials: "omit"; headers: Record<string, string> }) => Promise<PresentResponse>;

export async function getJsonObject(fetchFn: PresentFetch, url: string, timeoutMs = 8000, maxBytes = 2_000_000): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", credentials: "omit", headers: { accept: "application/json" } });
    if (res.status !== 200 || res.body === null) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
