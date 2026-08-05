import { defineWidget, normRef, widgetMarker } from "../defineWidget";

import type { NextJobPickerPayload } from "../../types";

// See the note on nextCompanyPicker: the live widget is confirm-first, but this
// projection stays flat (full list) on purpose so the harness can exercise
// every role, not just the top suggestion.
export const nextJobPickerDef = defineWidget<NextJobPickerPayload>({
  kind: "next_job_picker",
  toText: (p) => {
    const rows = [
      ...p.shortlisted.map((r) => ({
        jobId: r.jobId,
        label: `${r.title}${r.location ? ` — ${r.location}` : ""}${r.compensation ? `, ${r.compensation}` : ""}`,
      })),
      ...p.deferred.map((r) => ({
        jobId: r.jobId,
        label: `${r.title} (deferred earlier)`,
      })),
    ];
    const lines = rows.map((r, i) => `  ${i + 1}. ${r.label}`);
    return (
      `[Which role at ${p.companyName} do you want to work on?\n${lines.join("\n")}\n` +
      `  Or "done" if you're finished with ${p.companyName}]`
    );
  },
  harness: {
    actionHint:
      'widget_action with optionRef = a role number to work on it, or "done" to finish this company. Or send_message.',
    multiSelect: false,
    translate: (p, action) => {
      const rows = [
        ...p.shortlisted.map((r) => ({
          jobId: r.jobId,
          label: `${r.title}${r.location ? ` — ${r.location}` : ""}${r.compensation ? `, ${r.compensation}` : ""}`,
        })),
        ...p.deferred.map((r) => ({
          jobId: r.jobId,
          label: `${r.title} (deferred earlier)`,
        })),
      ];
      const r = normRef(action.optionRef);
      if (
        r.startsWith("done") ||
        r.startsWith("caught") ||
        r.startsWith("fin")
      ) {
        return widgetMarker(
          {
            kind: "next_job_picker",
            companyId: p.companyId,
            choice: "caught_up",
          },
          `[Done with ${p.companyName}]`,
        );
      }
      const n = Number(action.optionRef);
      if (!Number.isInteger(n) || n < 1 || n > rows.length) {
        return {
          error: `unrecognized next_job_picker optionRef: ${action.optionRef}`,
        };
      }
      const row = rows[n - 1];
      return widgetMarker(
        {
          kind: "next_job_picker",
          companyId: p.companyId,
          choice: "pick",
          jobId: row.jobId,
        },
        `[Work on ${row.label}]`,
      );
    },
  },
});
