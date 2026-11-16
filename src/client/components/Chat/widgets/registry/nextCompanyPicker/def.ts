import { defineWidget, normRef, widgetMarker } from "../defineWidget";

import type { NextCompanyPickerPayload } from "../../types";

// NOTE: the live widget renders confirm-first (a single top-suggestion card +
// a "See full list" toggle — see nextCompanyPicker/Widget.tsx). This projection
// deliberately flattens to the FULL numbered list so the audit persona /
// auditor can see and act on every option, not just the top suggestion.
// Keep it flat on purpose — matching the collapsed UI here would hide the tail
// from the harness and stop it exercising non-top picks. The harness translate
// rebuilds the same (immediate, deferred, backlog) ordering so an option number
// maps to the same row the auditor sees in the text.
export const nextCompanyPickerDef = defineWidget<NextCompanyPickerPayload>({
  kind: "next_company_picker",
  toText: (p) => {
    const rows = [...p.immediate, ...(p.deferred ?? []), ...p.backlog];
    const fmtRow = (r: (typeof rows)[number], i: number) => {
      if (r.kind === "company") {
        return `  ${i + 1}. ${r.name}${r.subtitle ? ` — ${r.subtitle}` : ""} [${r.status}]`;
      }
      if (r.kind === "job") {
        const at = r.companyName ? ` @ ${r.companyName}` : "";
        return `  ${i + 1}. ${r.title}${at} (role)${r.subtitle ? ` — ${r.subtitle}` : ""} [${r.status}]`;
      }
      return `  ${i + 1}. ${r.label} (lead)${r.subtitle ? ` — ${r.subtitle}` : ""} [${r.status}]`;
    };
    const immediateCount = p.immediate.length;
    const body = p.empty
      ? "  (nothing queued)"
      : rows.map((r, i) => fmtRow(r, i)).join("\n") +
        (immediateCount > 0 && immediateCount < rows.length
          ? `\n  (the first ${immediateCount} are flagged for immediate attention)`
          : "");
    return (
      `[Hank is asking what to work on next:\n${body}\n` +
      `  Or "add_companies" to add more companies to your watchlist]`
    );
  },
  harness: {
    actionHint:
      'widget_action with optionRef = a row number to work on it, or "add_companies". Or send_message.',
    multiSelect: false,
    translate: (p, action) => {
      const rows = [...p.immediate, ...(p.deferred ?? []), ...p.backlog];
      const r = normRef(action.optionRef);
      if (r.startsWith("add")) {
        return widgetMarker(
          { kind: "next_company_picker", choice: "add_companies" },
          "[Add more companies]",
        );
      }
      const n = Number(action.optionRef);
      if (!Number.isInteger(n) || n < 1 || n > rows.length) {
        return {
          error: `unrecognized next_company_picker optionRef: ${action.optionRef}`,
        };
      }
      const row = rows[n - 1];
      if (row.kind === "company") {
        return widgetMarker(
          { kind: "next_company_picker", choice: "company", companyId: row.id },
          `[Continue with ${row.name}]`,
        );
      }
      if (row.kind === "job") {
        return widgetMarker(
          { kind: "next_company_picker", choice: "job", jobId: row.id },
          `[Continue with ${row.title}]`,
        );
      }
      return widgetMarker(
        {
          kind: "next_company_picker",
          choice: "opportunity",
          opportunityId: row.id,
        },
        `[Continue with ${row.label}]`,
      );
    },
  },
});
