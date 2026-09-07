// Same-origin by default — FastAPI serves the built UI from static/.
// For `npm run dev` on :3000, set NEXT_PUBLIC_API_BASE=http://localhost:8500/api
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api";

// Only needed if the server runs with API_KEY set.
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;
const authHeader: Record<string, string> = API_KEY ? { "x-api-key": API_KEY } : {};

/**
 * Pull the human-readable reason out of an error response.
 *
 * The backend answers in two shapes: `{error}` from JSONResponse and `{detail}`
 * from FastAPI's HTTPException (which is an array for validation failures).
 * Reading only `error` turned every HTTPException into a bare "HTTP 400" and
 * threw away the sentence explaining what to do.
 */
function errorMessage(data: any, status: number): string {
  const d = data?.error ?? data?.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d) && d[0]?.msg) return [d[0].loc?.join("."), d[0].msg].filter(Boolean).join(": ");
  return `HTTP ${status}`;
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeader, ...opts.headers },
    body: opts.body && typeof opts.body === "string" ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(errorMessage(await res.json().catch(() => null), res.status));
  }
  return res.json();
}

// No Content-Type here — FormData sets its own multipart boundary.
export function apiRaw(path: string, opts: RequestInit = {}) {
  return fetch(`${API_BASE}${path}`, { ...opts, headers: { ...authHeader, ...opts.headers } });
}

/**
 * POST `path` and stream the SSE response.
 *
 * The server frames events as `event: <name>\ndata: <json>\n\n`, but the
 * network splits chunks anywhere — including between the event line and its
 * data line. `event`/`data` therefore live outside the read loop, otherwise a
 * badly-timed chunk boundary silently drops the event.
 */
export async function streamSSE(
  path: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiRaw(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(errorMessage(await res.json().catch(() => null), res.status));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
      else if (line === "" && event && data) {
        // One malformed frame shouldn't kill the whole stream — skip it and
        // keep reading the rest of the generation.
        try {
          onEvent(event, JSON.parse(data));
        } catch {
          console.warn("dropped malformed SSE frame:", event, data);
        }
        event = "";
        data = "";
      }
    }
  }
}

export const imageUrl = (path: string) => `${API_BASE}/images/${path}`;
export const referenceUrl = (id: string) => `${API_BASE}/reference/${id}`;
export const tilesetUrl = (name: string, file: string) => `${API_BASE}/tileset/${name}/${file}`;
