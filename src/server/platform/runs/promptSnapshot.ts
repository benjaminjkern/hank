// Deduped system-prompt skeleton store (admin /admin/runs inspector).
//
// The Hank system prompt is ~70KB rebuilt every turn, but its static skeleton is
// identical across turns of a given flow + code version. buildHankSystem splits
// the prompt into that skeleton (hashed) + the small volatile pieces (today /
// profile / client-errors, captured per-call in TokenUsage.requestParams). This
// stores each distinct skeleton exactly once, so the viewer can show the full
// prompt (skeleton + volatile) without persisting 70KB on every TokenUsage row.

import { prisma } from "@/server/db/prisma";

export async function upsertPromptSnapshot(args: {
  hash: string;
  flow: string;
  text: string;
}): Promise<void> {
  try {
    // First writer wins; later identical hashes are a cheap no-op update. Never
    // throw — a capture miss must not break the turn.
    await prisma.promptSnapshot.upsert({
      where: { hash: args.hash },
      create: { hash: args.hash, flow: args.flow, text: args.text },
      update: {},
    });
  } catch (err) {
    console.warn("[promptSnapshot] upsert failed:", err);
  }
}
