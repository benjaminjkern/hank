// Post-run regression checks over a persona's transcript. These turn the soft
// things a persona "happened to notice" (slow to value, stray internal status
// lines, a role count quoted before any scrape) into hard, repeatable signals
// surfaced in the report + index. They do NOT halt the run — they're a
// regression gate you read after the fact.

import { detectFabricatedUiRender } from "@/server/agent/session/uiProvenance";

import type { TurnRecord } from "../agent/personaAgent";

export type AssertionResult = {
  name: string;
  passed: boolean;
  detail: string;
};

// Tools / widgets that mean "Hank started delivering value" (companies/roles),
// as opposed to still eliciting profile info.
const VALUE_TOOLS = new Set([
  "search_jobs",
  "list_jobs",
  "read_job_description",
  // legacy names (get_job_details → view_job_description → read_job_description);
  // kept so old sessions still score.
  "view_job_description",
  "get_job_details",
  // Retired shortlist tools — shortlisting is now a rung of company_walkthrough.
  // Kept so old sessions still score.
  "refresh_shortlist",
  "display_shortlist",
  "propose_shortlist",
  "enrich_companies",
  "company_walkthrough",
  "company_checklist",
  // Inbound-opportunity intake path: surfacing the recruiter lead as a tracked
  // opportunity + role IS the value for that persona (no watchlist/shortlist
  // tools fire). Without these, turns_to_value false-fails the recruiter flow.
  "create_opportunities",
  "create_jobs",
]);
const VALUE_WIDGETS = new Set([
  "company_checklist",
  "shortlist_proposal",
  "next_company_picker",
]);

// Status lines should never expose internal mode / pipeline names.
const INTERNAL_STATUS_RE =
  /\bprofile setup\b|\bwalkthrough\b|\bwatchlist-add\b|\bpipeline\b|\bprescan\b|\bpre_scan\b|\bcurrentFlow\b/i;

// Raw internal data that must never appear in Hank's chat sentences — the
// class of leak that halted persona 03 (companyId=<cuid>, careersUrl=,
// PRE_SCAN bucket counts, "phase N/4", cross-user collision, raw cuids).
const RAW_INTERNALS_RE =
  /\bcompanyId=|\bcareersUrl=|\bsourceUrl=|\bgreenhouseSlug\b|\bPRE_SCAN\b|\bphase \d\/\d\b|cross-user collision|upserted \d+ jobs|\bc[a-z0-9]{24,}\b/;

// Internal *vocabulary* that must never surface in Hank's chat sentences: raw
// uppercase status enums, and behind-the-scenes machinery verbs (scrape/scan a
// "board", prescan, "the scan ran into an issue", "the walkthrough wrapped",
// pipeline/runner/picker names). This is the leak class persona 02 caught that
// the raw-data regex above missed — Hank explaining a prescan-skipped company
// reached for "status is currently CLOSED" / "scraping and scanning their
// board" / "the scan ran into an issue". Uppercase-only on the bare enums so
// ordinary English ("I skipped that one") doesn't false-positive.
const CHAT_VOCAB_LEAK_RE =
  /\b(?:CLOSED|DEFERRED|CAUGHT_UP|SCANNED|SHORTLISTED|NOT_A_MATCH)\b|(?:scrap(?:e|ed|ing)|scann?(?:ed|ing))\b[\w ]*\bboard\b|\bthe scan (?:ran into|failed|hit|errored)|\bpre[\s_-]?scan\b|the walkthrough (?:wrapped|ran)|\bthe (?:pipeline|state machine|runner|picker|orchestrator|rung|walker)\b/;

const TURNS_TO_VALUE_MAX = 6;

export function runAssertions(turns: TurnRecord[]): AssertionResult[] {
  const out: AssertionResult[] = [];

  // 1. Turns to first value.
  let firstValueTurn: number | null = null;
  for (const t of turns) {
    const vt = t.visibleTurn;
    const tooled = vt.toolChips.some((n) => VALUE_TOOLS.has(n));
    const widgeted = vt.widget ? VALUE_WIDGETS.has(vt.widget.kind) : false;
    if (tooled || widgeted) {
      firstValueTurn = t.turn;
      break;
    }
  }
  out.push({
    name: "turns_to_value",
    passed: firstValueTurn !== null && firstValueTurn <= TURNS_TO_VALUE_MAX,
    detail:
      firstValueTurn === null
        ? "Hank never surfaced companies/roles (no value tool/widget fired)"
        : `first value at turn ${firstValueTurn} (max ${TURNS_TO_VALUE_MAX})`,
  });

  // 2. No internal mode/pipeline names in status lines.
  const badStatus: string[] = [];
  for (const t of turns) {
    for (const s of t.visibleTurn.statusLines) {
      if (INTERNAL_STATUS_RE.test(s)) badStatus.push(`t${t.turn}: "${s}"`);
    }
  }
  out.push({
    name: "no_internal_status",
    passed: badStatus.length === 0,
    detail: badStatus.length
      ? badStatus.join("; ")
      : "no internal mode names in status lines",
  });

  // (Dropped: a "no role count before a scrape" check. The word "roles" is
  //  ambiguous — career history ("your last 3 roles") vs openings ("3 open
  //  roles") — so a mechanical count check is too noisy to be useful. The
  //  premature-count behavior is covered by the prompt rule + the persona
  //  noticing a flip-flop; the precise leak class below is the valuable check.)

  // 3. No raw internal data OR internal vocabulary in Hank's chat sentences.
  const rawLeaks: string[] = [];
  for (const t of turns) {
    const text = t.visibleTurn.assistantText;
    const m = RAW_INTERNALS_RE.exec(text) ?? CHAT_VOCAB_LEAK_RE.exec(text);
    if (m) rawLeaks.push(`t${t.turn}: "${m[0]}"`);
  }
  out.push({
    name: "no_raw_internals_in_chat",
    passed: rawLeaks.length === 0,
    detail: rawLeaks.length
      ? `internal data leaked into chat — ${rawLeaks.join("; ")}`
      : "no raw internal data in chat sentences",
  });

  // 4. Hank never confabulates a system-rendered surface — typing out a role
  //    menu / shortlist / picker in prose (or echoing the <system-reminder>
  //    operator marker) instead of letting the system render it. This is the
  //    Block-roles failure class: Hank invented a checkmarked role list after a
  //    company switch. Hard hits fail the assertion; fuzzy widget-shape hits are
  //    reported in the detail but don't fail on their own.
  const hardHits: string[] = [];
  const fuzzyHits: string[] = [];
  for (const t of turns) {
    const res = detectFabricatedUiRender(t.visibleTurn.assistantText);
    for (const r of res.reasons) {
      const entry = `t${t.turn}: ${r.note} ("${r.match}")`;
      (r.tier === "hard" ? hardHits : fuzzyHits).push(entry);
    }
  }
  out.push({
    name: "no_confabulated_widgets",
    passed: hardHits.length === 0,
    detail: hardHits.length
      ? `Hank drew the screen in prose — ${hardHits.join("; ")}${fuzzyHits.length ? ` | also flagged (review): ${fuzzyHits.join("; ")}` : ""}`
      : fuzzyHits.length
        ? `no hard reproduction; review possible widget-shaped prose — ${fuzzyHits.join("; ")}`
        : "no confabulated on-screen surfaces in chat",
  });

  return out;
}
