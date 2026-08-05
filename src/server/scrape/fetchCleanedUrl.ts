// Fetch one arbitrary URL and return its cleaned, HTML-stripped text, capped so
// a result doesn't sit in the conversation as 100KB forever. The domain half of
// the fetch_url tool (and reusable by any caller that needs a one-off page). The
// tool layer shapes the UPSTREAM_FETCH_FAILED toolError + its dedupKey from the
// discriminated result.

import { assertPublicUrl } from "@/server/platform/net/assertPublicUrl";
import { htmlToText } from "@/utils/html";
import { urlHost } from "@/utils/url";

import { scrapeFetchSignal } from "./scrapeSignal";

const MAX_CHARS = 8_000;
const TIMEOUT_MS = 15_000;

export type FetchCleanedUrlResult =
  | { ok: true; text: string }
  | {
      ok: false;
      kind: "non_200";
      status: number;
      statusText: string;
      host: string;
    }
  | { ok: false; kind: "threw"; message: string; host: string };

export async function fetchCleanedUrl(
  url: string,
  opts?: { maxChars?: number; timeoutMs?: number },
): Promise<FetchCleanedUrlResult> {
  const maxChars = opts?.maxChars ?? MAX_CHARS;
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const host = urlHost(url) ?? "unknown";
  try {
    // SSRF guard: refuse loopback / private / link-local / metadata targets
    // before the request leaves the process (a thrown BlockedUrlError falls
    // through to the "threw" branch below like any other fetch failure).
    await assertPublicUrl(url);
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; HankBot/0.1; +https://hank.local) chat-first-job-tool",
        Accept: "text/html, application/json, */*;q=0.5",
      },
      redirect: "follow",
      signal: scrapeFetchSignal(timeoutMs),
    });
    if (!res.ok) {
      return {
        ok: false,
        kind: "non_200",
        status: res.status,
        statusText: res.statusText,
        host,
      };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const rawBody = await res.text();
    // For HTML, strip the markup; JSON / plain text passes through. This is the
    // difference between "100KB in your history forever" and "8KB".
    const cleaned = contentType.includes("html")
      ? htmlToText(rawBody)
      : rawBody;
    const text =
      cleaned.length > maxChars
        ? `${cleaned.slice(0, maxChars)}\n\n[...truncated ${cleaned.length - maxChars} chars of cleaned text]`
        : cleaned;
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      kind: "threw",
      message: err instanceof Error ? err.message : String(err),
      host,
    };
  }
}
