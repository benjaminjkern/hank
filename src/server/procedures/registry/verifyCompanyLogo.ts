// Fetch a candidate logo image and ask the vision sub-agent whether it's really
// this company's logo.
//
// The fetch lives here rather than in the sub-agent because a `SubAgentDef` does
// no I/O — and because "couldn't fetch the image" is a decision about whether to
// spend a vision call at all, which is the caller's to make. Both outcomes
// degrade the same way: an unverifiable logo is `uncertain`, and the UI falls
// back to the company-name monogram. Persisting the verdict is the caller's own
// enrichCompanies/applyLogoVerdict.ts.

import type { RunContext } from "@/server/agent/contracts";
import { assertPublicUrl } from "@/server/platform/net/assertPublicUrl";
import { traceText } from "@/server/platform/trace/traceText";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  logoVerifierSubAgent,
  type LogoImage,
  type LogoVerifierResult,
} from "@/server/subagents/registry/logoVerifier";

// Anthropic image blocks accept jpeg/png/gif/webp. ICO (favicons) and SVG
// (vector logos) are not supported — report "uncertain" for those rather than
// guess. The Google favicon service always returns PNG so the common path works.
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 5_000_000; // Anthropic's per-image limit

export type VerifyCompanyLogoInput = {
  companyName: string;
  candidateLogoUrl: string;
  // Cost-attribution label only — nothing here reads or writes the company.
  companyId?: string;
};

export async function runVerifyCompanyLogo(
  input: VerifyCompanyLogoInput,
  ctx: RunContext,
): Promise<LogoVerifierResult> {
  const fetched = await fetchImageBlock(input.candidateLogoUrl, ctx.signal);
  if (!fetched.ok) {
    // The image couldn't be fetched as a Claude-supported media type. Bail
    // gracefully — no verdict, and no vision call to pay for.
    traceText(ctx.trace, `logo verifier: skipped — ${fetched.reason}`);
    return { verdict: "uncertain", betterUrl: null, analysis: fetched.reason };
  }

  const result = await runSubAgent(
    logoVerifierSubAgent,
    {
      companyName: input.companyName,
      candidateLogoUrl: input.candidateLogoUrl,
      companyId: input.companyId,
      image: fetched.image,
    },
    ctx,
  );

  // A failed verification is never fatal — the UI falls back to the monogram.
  if (!result.ok) {
    return { verdict: "uncertain", betterUrl: null, analysis: result.error };
  }

  // Human-readable verdict line, not a tool result — the verdict is the point
  // of the sub-agent and worth showing, but it is prose in the parent's trace.
  traceText(
    ctx.trace,
    [
      `logo verdict: ${result.output.verdict}`,
      result.output.betterUrl ? `better URL ${result.output.betterUrl}` : null,
      result.output.analysis ? `— ${result.output.analysis}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return result.output;
}

type FetchResult =
  { ok: true; image: LogoImage } | { ok: false; reason: string };

async function fetchImageBlock(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  try {
    // SSRF guard: candidateLogoUrl can be an agent/user-supplied override
    // (update_company's logoUrl), so block loopback / RFC-1918 / link-local /
    // cloud-metadata targets before fetching. A throw here degrades to the same
    // graceful "uncertain" verdict as any other unfetchable image (the catch
    // below converts it to { ok: false }).
    await assertPublicUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    // A user Stop tears the fetch down too, not just the LLM call after it.
    const onParentAbort = () => controller.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; HankBot/0.1; +https://hank.local) chat-first-job-tool",
          Accept: "image/png, image/jpeg, image/webp, image/gif, image/*;q=0.5",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onParentAbort);
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: `fetch ${url}: ${res.status} ${res.statusText}`,
      };
    }
    const contentType = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(contentType)) {
      return {
        ok: false,
        reason: `unsupported content-type "${contentType}" — Anthropic image blocks accept jpeg/png/gif/webp only`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `image too large (${buf.byteLength} bytes; max ${MAX_IMAGE_BYTES})`,
      };
    }
    return {
      ok: true,
      image: {
        mediaType: contentType as LogoImage["mediaType"],
        base64: buf.toString("base64"),
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
