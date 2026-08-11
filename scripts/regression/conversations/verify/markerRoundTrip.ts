// Zero-spend verification: for every widget kind, render a canned payload to
// text, translate a representative persona action into a marker, and run that
// marker through the REAL server parser — asserting it parses and carries the
// expected fields. This is the structural guarantee that the harness's
// "clicks" land, without calling Anthropic or touching the DB.

import {
  parseAddMoreCompaniesSubmission,
  parseNextCompanyPickerSubmission,
  parseWidgetSubmission,
} from "@/server/widgets/parse";

import { buildRenderedWidget } from "../driver/widgetRender";

import type { PersonaWidgetAction } from "../driver/widgetRender";

type Case = {
  name: string;
  payload: unknown;
  kind: Parameters<typeof buildRenderedWidget>[0];
  action: PersonaWidgetAction;
  parse: (marker: string) => unknown | null;
  assert: (parsed: any) => string | null; // return error string or null
};

const CASES: Case[] = [
  {
    name: "add_more_companies:done",
    kind: "add_more_companies",
    payload: {
      kind: "add_more_companies",
      addedThisBatch: ["Vercel"],
      passedCount: 2,
    },
    action: { optionRef: "done" },
    // "Done adding" is the primary action, and `settled` (added + passed) is
    // what tells the server this round is a real topic boundary.
    parse: parseAddMoreCompaniesSubmission,
    assert: (p) =>
      p && p.answer === "no" && p.settled === 3
        ? null
        : `bad add_more done: ${JSON.stringify(p)}`,
  },
  {
    name: "add_more_companies:more",
    kind: "add_more_companies",
    payload: {
      kind: "add_more_companies",
      addedThisBatch: ["Vercel"],
      passedCount: 0,
    },
    action: { optionRef: "more" },
    parse: parseAddMoreCompaniesSubmission,
    assert: (p) =>
      p && p.answer === "yes"
        ? null
        : `bad add_more more: ${JSON.stringify(p)}`,
  },
  {
    name: "confirm_revive_company",
    kind: "confirm_revive_company",
    payload: {
      kind: "confirm_revive_company",
      companyId: "cmpR",
      companyName: "dbt Labs",
      reasoning: "set aside earlier",
    },
    action: { optionRef: "revive" },
    parse: parseWidgetSubmission,
    assert: (p) =>
      p &&
      p.kind === "confirm_revive_company" &&
      p.companyId === "cmpR" &&
      p.answer === "yes"
        ? null
        : `bad confirm_revive: ${JSON.stringify(p)}`,
  },
  {
    name: "confirm_revive_company:no",
    kind: "confirm_revive_company",
    payload: {
      kind: "confirm_revive_company",
      companyId: "cmpR",
      companyName: "dbt Labs",
      reasoning: "set aside earlier",
    },
    action: { optionRef: "no" },
    parse: parseWidgetSubmission,
    assert: (p) =>
      p &&
      p.kind === "confirm_revive_company" &&
      p.companyId === "cmpR" &&
      p.answer === "no"
        ? null
        : `bad confirm_revive no: ${JSON.stringify(p)}`,
  },
  {
    name: "confirm_application_submit",
    kind: "confirm_application_submit",
    payload: {
      kind: "confirm_application_submit",
      jobId: "job7",
      jobTitle: "Designer",
      companyName: "Notion",
    },
    action: { optionRef: "confirm" },
    parse: parseWidgetSubmission,
    assert: (p) =>
      p && p.kind === "confirm_application_submit" && p.jobId === "job7"
        ? null
        : `bad confirm_submit: ${JSON.stringify(p)}`,
  },
  {
    name: "next_company_picker:company",
    kind: "next_company_picker",
    payload: {
      kind: "next_company_picker",
      immediate: [
        {
          kind: "company",
          id: "cmpA",
          name: "Datadog",
          logoUrl: null,
          sourceUrl: null,
          subtitle: "2 new roles",
          status: "ACTIVE",
        },
      ],
      backlog: [
        {
          kind: "opportunity",
          id: "oppB",
          label: "Recruiter lead",
          subtitle: "via agency",
          status: "OPEN",
        },
      ],
      empty: false,
    },
    action: { optionRef: 1 },
    parse: parseNextCompanyPickerSubmission,
    assert: (p) =>
      p &&
      p.kind === "next_company_picker" &&
      p.choice === "company" &&
      p.companyId === "cmpA"
        ? null
        : `bad next_picker company: ${JSON.stringify(p)}`,
  },
  {
    name: "next_company_picker:opportunity",
    kind: "next_company_picker",
    payload: {
      kind: "next_company_picker",
      immediate: [
        {
          kind: "company",
          id: "cmpA",
          name: "Datadog",
          logoUrl: null,
          sourceUrl: null,
          subtitle: "",
          status: "ACTIVE",
        },
      ],
      backlog: [
        {
          kind: "opportunity",
          id: "oppB",
          label: "Recruiter lead",
          subtitle: "",
          status: "OPEN",
        },
      ],
      empty: false,
    },
    action: { optionRef: 2 },
    parse: parseNextCompanyPickerSubmission,
    assert: (p) =>
      p &&
      p.kind === "next_company_picker" &&
      p.choice === "opportunity" &&
      p.opportunityId === "oppB"
        ? null
        : `bad next_picker opp: ${JSON.stringify(p)}`,
  },
  {
    name: "next_job_picker:pick",
    kind: "next_job_picker",
    payload: {
      companyId: "cmpJ",
      companyName: "Ramp",
      shortlisted: [
        {
          jobId: "j1",
          title: "Senior Backend Engineer",
          location: "NYC",
          compensation: "$220k",
        },
      ],
      deferred: [
        {
          jobId: "j2",
          title: "Staff Engineer",
          deferReason: "USER_PAUSED",
        },
      ],
    },
    action: { optionRef: 1 },
    parse: parseWidgetSubmission,
    assert: (p) =>
      p &&
      p.kind === "next_job_picker" &&
      p.choice === "pick" &&
      p.jobId === "j1" &&
      p.companyId === "cmpJ"
        ? null
        : `bad next_job_picker pick: ${JSON.stringify(p)}`,
  },
  {
    name: "next_job_picker:done",
    kind: "next_job_picker",
    payload: {
      companyId: "cmpJ",
      companyName: "Ramp",
      shortlisted: [],
      deferred: [],
    },
    action: { optionRef: "done" },
    parse: parseWidgetSubmission,
    assert: (p) =>
      p &&
      p.kind === "next_job_picker" &&
      p.choice === "caught_up" &&
      p.companyId === "cmpJ"
        ? null
        : `bad next_job_picker done: ${JSON.stringify(p)}`,
  },
  {
    name: "next_company_picker:add",
    kind: "next_company_picker",
    payload: {
      kind: "next_company_picker",
      immediate: [],
      backlog: [],
      empty: true,
    },
    action: { optionRef: "add_companies" },
    parse: parseNextCompanyPickerSubmission,
    assert: (p) =>
      p && p.kind === "next_company_picker" && p.choice === "add_companies"
        ? null
        : `bad next_picker add: ${JSON.stringify(p)}`,
  },
];

export function runMarkerRoundTrip(): {
  passed: number;
  failed: number;
  lines: string[];
} {
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;
  for (const c of CASES) {
    const rendered = buildRenderedWidget(c.kind, c.payload);
    if (!rendered) {
      failed++;
      lines.push(`✗ ${c.name}: buildRenderedWidget returned null`);
      continue;
    }
    const t = rendered.translate(c.action);
    if ("error" in t) {
      failed++;
      lines.push(`✗ ${c.name}: translate error: ${t.error}`);
      continue;
    }
    // The marker the persona would send is the first line; the parser scans the
    // whole message for the marker comment.
    const parsed = c.parse(t.marker);
    const err = c.assert(parsed);
    // Also assert the rendered text never leaks the raw marker.
    const leaks = /<!--\s*widget-response/i.test(rendered.text);
    // If the action carried widget text, it must reach the visible label.
    const noteMissing = c.action.note
      ? !t.marker.includes(c.action.note)
      : false;
    if (err || leaks || noteMissing) {
      failed++;
      lines.push(
        `✗ ${c.name}: ${err ?? ""}${leaks ? " [render leaks raw marker]" : ""}${noteMissing ? " [widget note missing from submission]" : ""}`,
      );
    } else {
      passed++;
      lines.push(`✓ ${c.name}`);
    }
  }
  return { passed, failed, lines };
}
