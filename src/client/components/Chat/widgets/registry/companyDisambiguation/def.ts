import { defineWidget, widgetMarker } from "../defineWidget";

import type {
  CompanyDisambiguationPayload,
  CompanyDisambiguationCandidate,
} from "../../types";

export const companyDisambiguationDef =
  defineWidget<CompanyDisambiguationPayload>({
    kind: "company_disambiguation",
    toText: (p) => {
      const blocks = p.companies.map((c) => {
        const opts = c.candidates.map(
          (cand, i) =>
            `      ${i + 1}. ${cand.canonicalName} — ${cand.shortDescription}`,
        );
        return `  "${c.name}" could be:\n${opts.join("\n")}\n      or skip it`;
      });
      return (
        `[A name matched more than one company — pick which one you meant for each:\n` +
        `${blocks.join("\n")}]`
      );
    },
    harness: {
      actionHint:
        "widget_action with selection = the number(s) of the company option(s) you meant (one per ambiguous name; empty = none of them). Or send_message.",
      multiSelect: true,
      translate: (p, action) => {
        // Flatten every candidate across the (usually single) ambiguous company
        // into one global numbered list so the persona can address any by a
        // single number. For a single company the numbering matches toText
        // exactly; the multi-company case (rare) numbers globally here vs.
        // per-company in the text — acceptable for a manual harness. First pick
        // per company wins.
        const flat: Array<{
          companyId: string;
          cand: CompanyDisambiguationCandidate;
        }> = [];
        for (const c of p.companies) {
          for (const cand of c.candidates)
            flat.push({ companyId: c.companyId, cand });
        }
        const chosen = new Map<string, CompanyDisambiguationCandidate>();
        for (const s of action.selection ?? []) {
          const n = Number(s);
          if (Number.isInteger(n) && n >= 1 && n <= flat.length) {
            const { companyId, cand } = flat[n - 1];
            if (!chosen.has(companyId)) chosen.set(companyId, cand);
          }
        }
        const resolved = [...chosen.entries()].map(([companyId, cand]) => ({
          companyId,
          chosenUrl: cand.chosenUrl,
          canonicalName: cand.canonicalName,
          shortDescription: cand.shortDescription,
        }));
        const label = resolved.length
          ? `[Picked: ${resolved.map((r) => r.canonicalName).join(", ")}]`
          : "[Skipped all — none matched]";
        return widgetMarker(
          { kind: "company_disambiguation", resolved },
          label,
        );
      },
    },
  });
