import { defineWidget, widgetMarker } from "../defineWidget";

import type { CompanyChecklistPayload } from "../../types";

export const companyChecklistDef = defineWidget<CompanyChecklistPayload>({
  kind: "company_checklist",
  toText: (p) => {
    const lines = p.suggestions.map(
      (s, i) =>
        `  ${i + 1}. ${s.name}${s.reasoning ? `\n      ↳ ${s.reasoning}` : ""}`,
    );
    return (
      `[Companies to add — pick which to add to your watchlist (the rest are skipped):\n` +
      `${lines.join("\n")}]`
    );
  },
  harness: {
    actionHint:
      "widget_action with selection = the numbers of the companies to ADD (empty = skip all). Or send_message.",
    multiSelect: true,
    translate: (p, action) => {
      // Mirror the real CompanyChecklistWidget: carry each kept company's
      // reasoning (→ hunter extraContext) and the captured url (→ hunter
      // candidateUrl) back through the marker, not just the bare name.
      const picked: Array<{ name: string; context?: string; url?: string }> =
        [];
      const keptIdx = new Set<number>();
      for (const s of action.selection ?? []) {
        const n = Number(s);
        if (Number.isInteger(n) && n >= 1 && n <= p.suggestions.length) {
          keptIdx.add(n - 1);
          const sug = p.suggestions[n - 1];
          picked.push({ name: sug.name, context: sug.reasoning, url: sug.url });
        }
      }
      // Everything not selected is a decline. The harness has no way to express
      // a per-candidate reason, so these carry the name only — same as a user
      // who unchecks without saying why.
      const declined = p.suggestions
        .filter((_, i) => !keptIdx.has(i))
        .map((s) => ({ name: s.name }));
      const label = picked.length
        ? `[Added: ${picked.map((c) => c.name).join(", ")}]`
        : "[Skipped all suggestions]";
      return widgetMarker(
        { kind: "company_checklist", picked, declined },
        label,
      );
    },
  },
});
