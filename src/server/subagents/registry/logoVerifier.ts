// Logo verifier sub-agent (transform class).
//
// Hank's Company rows often only have a derived favicon URL based on the
// careers-page hostname, which is wrong when the ATS slug ≠ the real domain
// (Cognition Labs on Ashby slug "cognition" → cognition.com's favicon, which
// is a completely different company). This sub-agent checks one candidate
// logo URL against the company's actual name via Claude vision and either
// confirms the URL or proposes a better one.
//
// Transform-class: one forced call constrained to the output schema below, no
// read tools, all context front-loaded. Runs in parallel with PRE_SCAN after
// the URL/ATS hunter commits, inside the add-to-watchlist commit.
//
// Reads nothing and writes nothing — not even the candidate image: fetching it
// (and deciding what to do when it can't be fetched) is
// procedures/registry/verifyCompanyLogo.ts, which hands the bytes in. Persisting
// the verdict (Company.logoUrl + the logoVerifiedAt stamp) is the caller's own
// enrichCompanies/applyLogoVerdict.ts — same split as scanJob → applyScanMatch.
//
// Cost note: Haiku 4-5 slugs small-image vision tasks well at a fraction
// of Sonnet's cost. The candidate is typically a 128px favicon, so context
// is tiny. One Anthropic call per invocation.

import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// Anthropic, not DeepSeek: this sends an image content block, which DeepSeek's
// Anthropic-compatible endpoint rejects. Don't "optimize" it onto a DeepSeek
// model — the request 400s.
const MODEL: LlmModel = "claude-haiku-4-5";
const MAX_TOKENS = 1024;

export type LogoVerdict = "correct" | "wrong" | "uncertain";

// Anthropic image blocks accept jpeg/png/gif/webp only — ICO (favicons) and SVG
// (vector logos) are not supported, which is why the fetch step upstream bails
// to "uncertain" on those rather than sending them.
export type LogoImage = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
};

export type LogoVerifierInput = {
  companyName: string;
  candidateLogoUrl: string;
  // Fetched by the caller (procedures/registry/verifyCompanyLogo.ts) — a def
  // does no I/O.
  image: LogoImage;
  // Label carried onto the TokenUsage row for cost attribution only — nothing
  // here reads or writes the company.
  companyId?: string;
};

export type LogoVerifierResult = {
  verdict: LogoVerdict;
  // Set only when verdict="wrong" and the model offered a confident
  // replacement. The caller decides whether to commit it.
  betterUrl: string | null;
  // What the model said it saw — its scratchpad, which for this one sub-agent is
  // worth surfacing: the caller logs it on the trace so a wrong verdict on an
  // obscure logo is debuggable without a re-run.
  analysis: string | null;
};

const REPORT_LOGO_VERDICT_SCHEMA: SubAgentOutputSchema = {
  name: "report_logo_verdict",
  description:
    "Report whether the candidate image is a correct logo for the company. " +
    "verdict=correct when the image is recognizably the company's official " +
    "logo or wordmark. verdict=wrong when it's a different company's logo " +
    "(common when the favicon service guessed the wrong domain), a 404 / " +
    "placeholder image, or otherwise unrelated. verdict=uncertain when " +
    "you can't tell (blurry, generic, no recognizable mark). When verdict=" +
    "wrong, include betterUrl only if you are confident in the replacement; " +
    "otherwise omit it.",
  inputSchema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string",
        enum: ["correct", "wrong", "uncertain"],
        description: "Set AFTER `analysis`, matching what you described there.",
      },
      betterUrl: {
        type: "string",
        description:
          "Optional. Only set when verdict=wrong and you have a high-confidence replacement URL. Leave omitted otherwise — better to fall back to the company monogram than to guess.",
      },
    },
    required: ["verdict"],
  },
};

export const logoVerifierSubAgent: SubAgentDef<
  LogoVerifierInput,
  { verdict?: string; betterUrl?: string; analysis?: string },
  LogoVerifierResult
> = {
  name: "logo_verifier",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "One sentence describing what the image actually shows (which company's mark, or that it's a placeholder / 404 / too blurry to read) and how it compares to the expected company. Describe before you judge — naming the mark you see is what keeps `verdict` from drifting to a guess about the company.",
  },
  // No system prompt: the whole instruction lives beside the image.
  userContent: (input) => [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: input.image.mediaType,
        data: input.image.base64,
      },
    },
    {
      type: "text",
      text: buildPrompt(input.companyName, input.candidateLogoUrl),
    },
  ],
  outputSchema: REPORT_LOGO_VERDICT_SCHEMA,
  caption: (input) => `verifying logo for "${input.companyName}" via vision…`,
  usageNotes: (input) =>
    input.companyId ? `companyId=${input.companyId}` : "turn=1",
  parse(out) {
    const verdict: LogoVerdict =
      out.verdict === "correct" || out.verdict === "wrong"
        ? out.verdict
        : "uncertain";
    const betterUrl =
      verdict === "wrong" &&
      typeof out.betterUrl === "string" &&
      out.betterUrl.length > 0
        ? out.betterUrl
        : null;
    return { verdict, betterUrl, analysis: out.analysis ?? null };
  },
};

function buildPrompt(companyName: string, candidateUrl: string): string {
  return `You are verifying whether this image is the correct logo for "${companyName}".

The candidate image URL is: ${candidateUrl}

Context — this candidate is often a Google favicon-service result derived from the company's careers-page hostname. When the company's ATS slug doesn't match their real domain (e.g. Cognition Labs uses the Ashby slug "cognition" but lives at cognition.ai, not cognition.com), the derived favicon is for an unrelated company. Other failure modes: a default placeholder/404 image, a generic browser icon, or a tiny illegible glyph.

Calibration — when the favicon's source domain (the \`domain=\` value in the candidate URL) IS the company's own primary domain (e.g. stripe.com for Stripe, anthropic.com for Anthropic), the image is almost certainly the company's real favicon. Default to "correct" in that case unless you see clear evidence of the slug→domain collision above (a recognizably DIFFERENT company's logo). Do not reject a real favicon as "generic" or "placeholder" just because the mark is minimal — many legitimate logos are a single letter, a simple geometric glyph, or a flat wordmark. "wrong" is for a clearly different company's logo or an actual broken/placeholder image, not for "this looks plain."

Decide:
- "correct" if the image is recognizably the official logo or wordmark for ${companyName}, OR it's a plausible mark served from the company's own primary domain.
- "wrong" only if it's clearly a DIFFERENT company's logo, an actual placeholder/404, or unrelated.
- "uncertain" if you genuinely can't tell (too small, illegible, blurry).

If verdict="wrong" and you have high confidence in a replacement URL, include it as betterUrl. Otherwise omit betterUrl — the UI falls back to a company-name monogram, which is fine. Don't guess.

Call report_logo_verdict with your decision.`;
}
