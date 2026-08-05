// Deterministically probe the slug-guessable ATSes for a company.
//
// Sub-agent-only — not in `hankToolsFor`. Replaces the basic-info hunter's
// prose slug-guessing for the easy + domain-style cases: generate the obvious
// name/domain-derived slugs and test_scrape them across
// Greenhouse/Lever/Ashby/Teamtailor/Gem in parallel — free, no LLM, no
// web_search. The slug-candidate logic + cross-product live in
// scrape/slugProbe.ts (pure, unit-tested); this is the thin tool wrapper.
//
// Returns every board with >=2 real jobs; the hunter validates each hit against
// the *right* company before reporting one (a name-derived slug can collide —
// the "Arbor" failure mode).

import { z } from "zod";

import { withScrapeSignal } from "@/server/scrape/scrapeSignal";
import { probeAtsBoards } from "@/server/scrape/slugProbe";

import type { ToolDef } from "../lib/types";

export const probeAtsTool: ToolDef<{ name: string; domain?: string }> = {
  name: "probe_ats",
  description:
    "Deterministically probe common ATS boards for a company by trying name- and domain-derived slug candidates across Greenhouse/Lever/Ashby/Teamtailor/Gem in parallel — free, no LLM, no web_search. Returns every board that produced ≥2 real jobs (provider, url, jobCount, companyName, sampleTitles). Call this FIRST, before guessing slugs by hand or reaching for web_search: it covers the obvious slugs AND the domain-style ones (e.g. Ashby's `qdrant.tech`) in one shot. Pass `domain` (the company's website host, e.g. `qdrant.tech`) whenever you know it — domain-style slugs can't be derived from the name alone. If it returns hits, VALIDATE each against the target company (companyName / sampleTitles must match who you were sent to find — the same collision gate as test_scrape) before reporting one as sourceUrl. If it returns nothing, the slug is genuinely unguessable (e.g. Greenhouse `sourcegraph91`) — escalate to web_search / fetch_url, or run test_scrape on the company's careers page. Does NOT cover the custom-domain enterprise ATSes (Workday, iCIMS), which have no slug to guess — test_scrape resolves those from a careers page.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The company name to derive slug candidates from.",
      },
      domain: {
        type: "string",
        description:
          'Optional. The company\'s website host (e.g. "qdrant.tech", "sourcegraph.com"). Strongly recommended when known — Ashby and some others use the literal domain as the board slug, which can\'t be guessed from the name.',
      },
    },
    required: ["name"],
  },
  parser: z.object({ name: z.string(), domain: z.string().optional() }),
  // The fan-out makes this the longest-running read tool in the set, so the
  // scope matters most here: without it a Stop leaves every probe in flight.
  async handle({ name, domain }, ctx) {
    const hits = await withScrapeSignal(ctx.signal, () =>
      probeAtsBoards({ name, domain }),
    );
    ctx.signal?.throwIfAborted();
    if (hits.length === 0) {
      return {
        content: `probe_ats "${name}"${domain ? ` (domain ${domain})` : ""}: no ATS board matched any name/domain-derived slug. The slug is likely unguessable (numeric suffix, bespoke), or the company is on a custom-domain enterprise ATS (Workday / iCIMS) that has no slug at all. Escalate to web_search / fetch_url, or run test_scrape on the company's careers page to resolve the board behind it.`,
      };
    }
    const lines = hits.map(
      (h) =>
        `- ${h.provider}: ${h.url} — ${h.jobCount} job${h.jobCount === 1 ? "" : "s"}, companyName="${h.companyName}"${
          h.sampleTitles.length
            ? `, sample: ${h.sampleTitles
                .slice(0, 3)
                .map((t) => `"${t}"`)
                .join(", ")}`
            : ""
        }`,
    );
    return {
      content: `probe_ats "${name}": ${hits.length} candidate board${hits.length === 1 ? "" : "s"} found. VALIDATE each matches the target company (companyName / sample titles) before reporting one as sourceUrl — a name-derived slug can hit an unrelated company on the same ATS:\n${lines.join("\n")}`,
    };
  },
};
