// Push what the recent conversation revealed into the memory files.
//
// The pairing of "which slice of the transcript" + the consolidation sub-agent,
// shared by the two procedures that wrap up a stretch of conversation
// (runWrapCompanySegment, runCommitProfile). Everything that touches the store
// lives here rather than in the sub-agent: reading the ChatMessage rows, loading
// the memory inventory the sub-agent judges against, and performing the writes
// it proposes. That split is what lets the audit harness drive the sub-agent
// over fixtures.
//
// Both callers run this BEFORE runCompactSession: consolidation is what makes the
// truncation safe, and in runCommitProfile the verdict gate that follows has to
// see post-write memory.

import type { RunContext } from "@/server/agent/contracts";
import {
  serializeTranscript,
  type StoredMessage,
} from "@/server/agent/session/serializeTranscript";
import { prisma } from "@/server/db/prisma";
import {
  readMemory,
  readMemories,
  writeMemory,
  appendMemory,
  mergeMemorySection,
  listMemories,
} from "@/server/memory/store";
import { withTraceSpan } from "@/server/platform/trace/span";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  memoryConsolidationSubAgent,
  type ConsolidationWrite,
  type MemoryConsolidationInput,
} from "@/server/subagents/registry/memoryConsolidation";

// Bounded recent window, so a wrap doesn't re-ingest the entire history every
// time. Deliberately independent of compaction's cutoff: consolidation still
// has to run when the session is too short to compact.
const RECENT_MESSAGES = 40;

// A replace that shrinks a substantial file this much is treated as suspicious
// and downgraded to an append — see the guard below.
const ANTI_SHRINK_FLOOR = 200;

export async function runConsolidateSessionMemory(
  args: RunContext & { sessionId: string },
): Promise<{ writeCount: number }> {
  return await withTraceSpan(
    "consolidate_session_memory",
    args.trace,
    (trace) => consolidateSessionMemory({ ...args, trace }),
    (r) => `${r.writeCount} memory write${r.writeCount === 1 ? "" : "s"}`,
  );
}

async function consolidateSessionMemory(
  args: RunContext & { sessionId: string },
): Promise<{ writeCount: number }> {
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: args.sessionId },
    orderBy: { createdAt: "desc" },
    take: RECENT_MESSAGES,
    select: { role: true, content: true },
  });

  const input = await loadMemoryConsolidationInput(
    args.userId,
    messages.reverse(),
  );
  // Nothing was said in the window — don't spend the call.
  if (!input) return { writeCount: 0 };

  const result = await runSubAgent(memoryConsolidationSubAgent, input, args);

  if (!result.ok) {
    // Non-fatal — the wrap continues and the transcript still gets compacted.
    // Logged because it is otherwise entirely silent.
    console.warn("[runConsolidateSessionMemory] failed:", result.error);
    return { writeCount: 0 };
  }

  // The sub-agent proposes; the writes happen here. Keeping them out of the
  // tool loop is the "don't give sub-agents write tools" rule — and it's what
  // lets the audit harness run the real consolidation over fixtures without
  // touching the host user's memory.
  let writeCount = 0;
  for (const w of result.output.writes) {
    try {
      // A section write is scoped by construction — it can only touch the one
      // heading it names — so the anti-shrink veto (a whole-file guard) doesn't
      // apply to it, and applying it would defeat the point: shrinking one
      // section is exactly how two duplicate sections get merged back into one.
      if (w.mode === "section") {
        // eslint-disable-next-line no-await-in-loop -- writes can target the same note, and append/merge order is the content
        await mergeMemorySection(args.userId, w.path, w.section, w.content);
      } else if (
        // eslint-disable-next-line no-await-in-loop -- read-modify-write against the file the previous iteration may have just changed
        (await antiShrinkVeto(args.userId, w)) ||
        w.mode === "append"
      ) {
        // eslint-disable-next-line no-await-in-loop -- append order is the content
        await appendMemory(args.userId, w.path, w.content);
      } else {
        // eslint-disable-next-line no-await-in-loop -- a whole-file replace must see every earlier write to that file
        await writeMemory(args.userId, w.path, w.content);
      }
      writeCount++;
    } catch (e) {
      console.warn(
        `[runConsolidateSessionMemory] write to ${w.path} failed:`,
        e,
      );
    }
  }
  return { writeCount };
}

// The memory inventory the consolidator judges against. Exported so the audit
// harness can assemble the same input a real wrap would. Null when the window
// holds nothing that was SAID — there's nothing to consolidate from.
export async function loadMemoryConsolidationInput(
  userId: string,
  messages: StoredMessage[],
): Promise<MemoryConsolidationInput | null> {
  // Serialized HERE for the two things it drives — whether there's anything to
  // consolidate, and which entity notes to preload. The def renders its own copy
  // for the prompt from the same rows.
  const transcript = serializeTranscript(messages, { includeToolCalls: false });
  if (!transcript.trim()) return null;

  const [profile, frequentQuestions, allPaths] = await Promise.all([
    readMemory(userId, "profile.md"),
    readMemory(userId, "frequent_questions.md"),
    listMemories(userId),
  ]);

  // Every note the transcript touched, in ONE query — a busy segment can name a
  // dozen of them, and a read apiece is a round trip apiece.
  const touched = scanTranscriptForEntities(transcript);
  const companySlugs = [...touched.companySlugs];
  const jobSlugs = [...touched.jobSlugs];
  const notes = await readMemories(userId, [
    ...companySlugs.map((slug) => `companies/${slug}.md`),
    ...jobSlugs.map((slug) => `jobs/${slug}.md`),
  ]);
  const companyNotes = companySlugs
    .map((slug) => ({ slug, content: notes.get(`companies/${slug}.md`) }))
    .filter((n): n is { slug: string; content: string } => !!n.content);
  const jobNotes = jobSlugs
    .map((slug) => ({ slug, content: notes.get(`jobs/${slug}.md`) }))
    .filter((n): n is { slug: string; content: string } => !!n.content);

  return {
    messages,
    allPaths,
    profile,
    frequentQuestions,
    companyNotes,
    jobNotes,
  };
}

// Find entity memory-path mentions in the transcript so we can preload their
// notes. Everything is addressed by slug now (no cuids), so all four kinds scan
// the same `{kind}/{slug}.md` shape.
function scanTranscriptForEntities(transcript: string): {
  jobSlugs: Set<string>;
  companySlugs: Set<string>;
  opportunitySlugs: Set<string>;
  contactSlugs: Set<string>;
} {
  const collectSlugs = (kind: string): Set<string> => {
    const out = new Set<string>();
    const re = new RegExp(`${kind}\\/([a-z0-9-]+)\\.md`, "g");
    for (const m of transcript.match(re) ?? []) {
      const slug = m.slice(`${kind}/`.length, -".md".length);
      if (slug) out.add(slug);
    }
    return out;
  };
  return {
    jobSlugs: collectSlugs("jobs"),
    companySlugs: collectSlugs("companies"),
    opportunitySlugs: collectSlugs("opportunities"),
    contactSlugs: collectSlugs("contacts"),
  };
}

// Replace-mode guard: if the existing file has more than minimal content AND the
// consolidation's new content is dramatically shorter, treat it as suspicious
// and refuse the replace (fall back to append). Protects against the "distill
// returned a one-liner; overwrote the user's notes" failure mode. It lives here,
// not in the sub-agent, because it compares against what's ON DISK.
//
// EXEMPTION: frequent_questions.md is a *curated, reconciled* stock-answer set,
// not a raw log — the carve-out in the prompt explicitly sanctions a shrinking
// replace there (drop a stale/superseded entry, dedupe). Applying the anti-shrink
// veto to it silently downgraded those reconciling replaces to append, so the
// file could only ever GROW — which is exactly how it became a junk drawer of
// orphaned answer fragments. So the veto skips it; the prompt's "preserve every
// non-contradictory entry" rule is the guard.
async function antiShrinkVeto(
  userId: string,
  write: ConsolidationWrite,
): Promise<boolean> {
  if (write.mode !== "replace" || write.path === "frequent_questions.md") {
    return false;
  }

  const existing = (await readMemory(userId, write.path))?.trim() ?? "";
  return (
    existing.length > ANTI_SHRINK_FLOOR &&
    write.content.length < existing.length / 3
  );
}
