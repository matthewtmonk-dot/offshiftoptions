/**
 * Plain-language text for a server action that THREW on the client (as opposed to returning a normal
 * {ok:false} result). After every deploy, a page that was opened BEFORE it still holds the old
 * action IDs; Next.js then throws "Server Action ... was not found" - which used to surface as a
 * vague "failed unexpectedly". That specific, harmless case now tells the user to refresh.
 */
export const STALE_PAGE_MESSAGE = "This page was opened before the latest app update, so its buttons are out of date. Refresh the page (Ctrl+F5, or pull down on your phone) and try again.";

export function describeActionFailure(error: unknown, fallback: string): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : typeof error === "string" ? error : "";
  return /server action/i.test(text) && /(not found|failed to find|unknown action|was not found)/i.test(text) ? STALE_PAGE_MESSAGE : fallback;
}

/**
 * A short, safe description of what the BROWSER saw when a server call failed (for example "Failed to
 * fetch" or "An unexpected response was received from the server."). These are the browser's own messages,
 * not server internals, so showing them is safe - and they are what tells a dropped connection apart from
 * a blocked request or a server error. Bounded and stripped of anything URL-like.
 */
export function shortErrorDetail(error: unknown): string {
  const text = error instanceof Error ? (error.message || error.name) : typeof error === "string" ? error : "";
  const cleaned = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned || "no detail from the browser";
}
