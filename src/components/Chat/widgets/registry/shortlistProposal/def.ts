import { z } from "zod";

import { defineWidget } from "../defineWidget";

// REPLAY-ONLY (docs/INCOMPLETE_MIGRATIONS.md): nothing emits shortlist_proposal
// anymore — the shortlist board (right panel) replaced the widget. Persisted
// `pipeline_widget` blocks in old sessions still carry this payload, so the
// shape + text projection survive for scrollback and model replay; the live
// component renders nothing and there is no harness binding.
export type ShortlistProposalPayload = {
  kind: "shortlist_proposal";
  companyId: string;
  companyName: string;
  viableJobs: Array<{
    id: string;
    title: string;
    location: string | null;
    compensation: string | null;
    employmentType: string | null;
    sourceUrl: string | null;
  }>;
  recommendedIds: string[];
  proposalNote: string | null;
  hankReasons?: Record<string, string>;
  scannedOnly?: boolean;
};

const ShortlistProposalSchema = z.object({
  kind: z.literal("shortlist_proposal"),
  companyId: z.string(),
  companyName: z.string(),
  viableJobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      compensation: z.string().nullable(),
      employmentType: z.string().nullable(),
      sourceUrl: z.string().nullable(),
    }),
  ),
  recommendedIds: z.array(z.string()),
  proposalNote: z.string().nullable(),
  hankReasons: z.record(z.string(), z.string()).optional(),
  scannedOnly: z.boolean().optional(),
});

// Parse a raw JSON string (a persisted tool-result body) into a payload — used
// by ChatPanel's SegmentView for old sessions. Isomorphic; lives with the def
// so the text projection and the parser can never disagree on the shape.
export function tryParseShortlistProposal(
  raw: string,
): ShortlistProposalPayload | null {
  try {
    const parsed = JSON.parse(raw);
    const validated = ShortlistProposalSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function validateShortlistProposal(
  value: unknown,
): ShortlistProposalPayload | null {
  const validated = ShortlistProposalSchema.safeParse(value);
  return validated.success ? validated.data : null;
}

export const shortlistProposalDef = defineWidget<ShortlistProposalPayload>({
  kind: "shortlist_proposal",
  validate: validateShortlistProposal,
  toText: (p) => {
    const rec = new Set(p.recommendedIds);
    const lines = p.viableJobs.map((j, i) => {
      const bits = [
        j.location ? j.location : null,
        j.compensation ? j.compensation : null,
        j.employmentType ? j.employmentType : null,
      ].filter(Boolean);
      const reason = p.hankReasons?.[j.id];
      return (
        `  ${i + 1}. ${j.title}${bits.length ? " — " + bits.join(", ") : ""}` +
        `${rec.has(j.id) ? "  [Hank recommends]" : ""}` +
        `${reason ? `\n      ↳ ${reason}` : ""}`
      );
    });
    return (
      `[A shortlist appeared for ${p.companyName}.` +
      `${p.proposalNote ? ` Hank's note: "${p.proposalNote}".` : ""}\n` +
      `These roles are on the table — you decide which to shortlist; the rest get passed on:\n` +
      `${lines.join("\n")}]`
    );
  },
});
