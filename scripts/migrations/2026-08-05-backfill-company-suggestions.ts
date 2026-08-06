// Reconstruct CompanySuggestion history from persisted company_checklist widgets.
//
// Every batch the company search has ever proposed is still on disk: each
// checklist was written into ChatMessage.content as a `pipeline_widget` block
// carrying its full suggestion list. A suggested name that has no Company is by
// construction a decline — createCompanyStubs runs for every pick, so even a
// pick whose enrichment failed still left a Company behind.
//
// That makes the whole decline history recoverable, which matters: without it
// the feedback loop ships empty and re-proposes everything the user has already
// turned down until they turn it down a second time.
//
// Needs app code rather than SQL because nameKey must come from the same
// slugify() the runtime uses — a hand-rolled lower/replace in SQL would drift
// and the dedup would silently miss.
//
// Dry-run by default; --apply writes. Delete this file once it reports 0
// remaining (and drop its gate migration's row from the ledger).

import "dotenv/config";

import {
  CompanySuggestionVerdict,
  type Prisma,
} from "../../src/generated/prisma/client";
import { prisma } from "../../src/server/db/prisma";
import { suggestionKey } from "../../src/server/entities/companies/companySuggestions";

type Suggestion = { name?: unknown; reasoning?: unknown; url?: unknown };

type Batch = {
  userId: string;
  sessionId: string;
  createdAt: Date;
  suggestions: Array<{ name: string; reason: string; url?: string }>;
};

function readBatches(
  rows: Array<{
    sessionId: string;
    createdAt: Date;
    content: Prisma.JsonValue;
    session: { userId: string };
  }>,
): Batch[] {
  const out: Batch[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "pipeline_widget" || b.kind !== "company_checklist") {
        continue;
      }
      const payload = b.payload as Record<string, unknown> | undefined;
      const raw = payload?.suggestions;
      if (!Array.isArray(raw)) continue;
      const suggestions = raw.flatMap((s: Suggestion) =>
        typeof s?.name === "string" && s.name.trim()
          ? [
              {
                name: s.name.trim(),
                reason:
                  typeof s.reasoning === "string" && s.reasoning.trim()
                    ? s.reasoning.trim()
                    : "(reason not recorded)",
                ...(typeof s.url === "string" && s.url.trim()
                  ? { url: s.url.trim() }
                  : {}),
              },
            ]
          : [],
      );
      if (suggestions.length > 0) {
        out.push({
          userId: row.session.userId,
          sessionId: row.sessionId,
          createdAt: row.createdAt,
          suggestions,
        });
      }
    }
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");

  // A missing table means the migration hasn't been applied yet. That's a fine
  // state to PREVIEW from — the whole point of the dry run is to see what will
  // land before committing to it — but not one to write from.
  let tableReady = true;
  try {
    const existing = await prisma.companySuggestion.count();
    if (existing > 0) {
      console.log(
        `CompanySuggestion already has ${existing} rows — this backfill has run. Nothing to do.`,
      );
      return;
    }
  } catch {
    tableReady = false;
    console.log(
      "(CompanySuggestion table doesn't exist yet — previewing against the migration that creates it.)\n",
    );
  }

  const rows = await prisma.chatMessage.findMany({
    where: { role: "ASSISTANT" },
    select: {
      sessionId: true,
      createdAt: true,
      content: true,
      session: { select: { userId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const batches = readBatches(rows);
  if (batches.length === 0) {
    console.log("No company_checklist batches found. Nothing to backfill.");
    return;
  }

  // A suggested name with a Company is one the user kept; without, declined.
  // Matched on suggestionKey, which strips the division qualifier the search
  // sometimes appends — so a company added as "Spotify" still matches a
  // suggestion that named it "Spotify (Advertising)". Keyed off the company's
  // NAME rather than its slug for the same reason.
  const companies = await prisma.company.findMany({
    select: { name: true, slug: true },
  });
  const companyKeys = new Set([
    ...companies.map((c) => suggestionKey(c.name)),
    ...companies.map((c) => c.slug),
  ]);

  // Newest verdict per (user, name) wins — the same name proposed in three
  // rounds is one history entry, and its LAST outcome is the current one.
  const latest = new Map<string, Batch["suggestions"][number] & Batch>();
  for (const batch of batches) {
    for (const s of batch.suggestions) {
      latest.set(`${batch.userId}|${suggestionKey(s.name)}`, {
        ...batch,
        ...s,
      });
    }
  }

  const data = [...latest.values()].map((s) => {
    const nameKey = suggestionKey(s.name);
    return {
      userId: s.userId,
      name: s.name,
      nameKey,
      reason: s.reason,
      url: s.url ?? null,
      verdict: companyKeys.has(nameKey)
        ? CompanySuggestionVerdict.ADDED
        : CompanySuggestionVerdict.DECLINED,
      sessionId: s.sessionId,
      // runId is deliberately null: these predate the column, so none of them
      // can be "the latest round" — which is the conservative answer, since the
      // hard no-re-propose rule should not fire on reconstructed history.
      createdAt: s.createdAt,
      decidedAt: s.createdAt,
    };
  });

  const added = data.filter(
    (d) => d.verdict === CompanySuggestionVerdict.ADDED,
  ).length;
  console.log(
    `${batches.length} checklist batches → ${data.length} distinct names: ${added} added, ${data.length - added} declined.`,
  );
  for (const d of data.filter(
    (x) => x.verdict === CompanySuggestionVerdict.DECLINED,
  )) {
    console.log(`  declined: ${d.name}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }
  if (!tableReady) {
    console.error(
      "\nCan't write: apply migration 20260805120000_company_suggestions first.",
    );
    process.exitCode = 1;
    return;
  }
  await prisma.companySuggestion.createMany({ data });
  console.log(`\nWrote ${data.length} rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
