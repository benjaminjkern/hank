import { assertPublicUrl } from "@/server/platform/net/assertPublicUrl";

import { scrapeFetchSignal } from "../scrapeSignal";

import { amazon } from "./providers/amazon";
import { apple } from "./providers/apple";
import { ashby } from "./providers/ashby";
import { eightfold } from "./providers/eightfold";
import { gem } from "./providers/gem";
import { google } from "./providers/google";
import { greenhouse } from "./providers/greenhouse";
import { icims } from "./providers/icims";
import { jazzhr } from "./providers/jazzhr";
import { lever } from "./providers/lever";
import { meta } from "./providers/meta";
import { netflix } from "./providers/netflix";
import { oracle } from "./providers/oracle";
import { rippling } from "./providers/rippling";
import { shopify } from "./providers/shopify";
import { smartrecruiters } from "./providers/smartrecruiters";
import { teamtailor } from "./providers/teamtailor";
import { workable } from "./providers/workable";
import { workday } from "./providers/workday";

import type { AtsHandler, AtsProviderModule, QuestionsHints } from "./shared";
import type { ApplicationQuestionsEnvelope, ScrapeResult } from "../types";

// Public re-exports: the scrape helpers used outside this module keep their
// existing "@/server/scrape/ats" import path (this file resolves that specifier).
export { extractGreenhouseSlugFromBoardUrl } from "./providers/greenhouse";
export { extractWorkdayBoardUrlFromHtml } from "./providers/workday";

// The provider registry. Detection walks it in order; hosts are distinct so
// order shouldn't matter, but don't rely on that. Add a new ATS = add a
// providers/{name}.ts and one entry here. See docs/ats-scrapers.md.
const REGISTRY: AtsProviderModule[] = [
  greenhouse,
  lever,
  ashby,
  workday,
  teamtailor,
  gem,
  amazon,
  smartrecruiters,
  workable,
  eightfold,
  rippling,
  oracle,
  apple,
  jazzhr,
  shopify,
  google,
  meta,
  netflix,
  icims,
];

// URL-regex-match a board URL to its provider's AtsHandler. Simple providers
// ship {jsonUrl, parse}; bespoke ones ship {fetchedUrl, fetchAll}. Null = not a
// recognized ATS URL.
export function detectAts(url: string): AtsHandler | null {
  for (const p of REGISTRY) {
    const handler = p.detect(url);
    if (handler) return handler;
  }
  return null;
}

// Router: delegates to the right ATS-specific questions fetcher based on URL
// shape. URLs that don't match any supported ATS return {status:"unsupported"}
// so the agent doesn't retry them. `hints` lets the caller pass company-level
// context (currently `greenhouseSlug`) that recovers from URLs whose host has
// been stripped by a custom-domain ATS integration.
export async function fetchApplicationQuestions(
  jobSourceUrl: string,
  hints?: QuestionsHints,
): Promise<ApplicationQuestionsEnvelope> {
  const h: QuestionsHints = hints ?? {};
  for (const p of REGISTRY) {
    if (!p.fetchQuestions || !p.matchesQuestions?.(jobSourceUrl, h)) continue;
    const env = await p.fetchQuestions(jobSourceUrl, h);
    // ok/empty/error stamp fetchedAt at their construction sites; a provider
    // returning "unsupported" without a stamp gets one here (the single
    // chokepoint) so needsQuestionsRefresh can retry a stale unsupported.
    if (env.status === "unsupported" && !env.fetchedAt) {
      return { ...env, fetchedAt: new Date().toISOString() };
    }
    return env;
  }
  return { status: "unsupported", fetchedAt: new Date().toISOString() };
}

// Wrapper used by scrapeUrl when a match was detected. Dispatches between
// the simple-GET path (Greenhouse / Lever / Ashby — one JSON fetch, one
// parse) and the bespoke-fetcher path (Workday / Teamtailor / Gem — paged
// or GraphQL or multi-step). Diagnostics are wired the same way for both so
// the agent's zero-jobs branch sees consistent metadata regardless of provider.
export async function scrapeViaAts(handler: AtsHandler): Promise<ScrapeResult> {
  if ("fetchAll" in handler) {
    try {
      return await handler.fetchAll();
    } catch (err) {
      return {
        ok: false,
        error: `${handler.provider}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  try {
    // SSRF guard: jsonUrl is derived from agent/careers-page input, so refuse
    // internal targets before fetching (caught below → an ordinary error result).
    await assertPublicUrl(handler.jsonUrl);
    const res = await fetch(handler.jsonUrl, {
      headers: { Accept: "application/json", "User-Agent": "HankBot/0.1" },
      redirect: "follow",
      signal: scrapeFetchSignal(20_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `${handler.provider} ${handler.jsonUrl}: ${res.status} ${res.statusText}`,
      };
    }
    const text = await res.text();
    if (!text.trim()) {
      return {
        ok: false,
        error: `${handler.provider} ${handler.jsonUrl}: empty body`,
      };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: `${handler.provider} ${handler.jsonUrl}: invalid JSON`,
      };
    }
    const company = handler.parse(data, handler.jsonUrl);
    return {
      ok: true,
      data: {
        ...company,
        diagnostics: {
          provider: handler.provider,
          fetchedUrl: handler.jsonUrl,
          pageLength: text.length,
          pageSnippet: text.slice(0, 400),
        },
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `${handler.provider}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
