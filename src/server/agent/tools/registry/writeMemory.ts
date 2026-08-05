import { z } from "zod";

import {
  readMemory,
  writeMemory,
  appendMemory,
  mergeMemorySection,
} from "@/server/memory/store";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// The user's profile slots (profile.md = thesis/constraints/framing, resume.md =
// their background). A whole-file `replace` here is the clobber path: the agent
// means to update one section and instead overwrites the entire note,
// collapsing the profile to a stub and putting good shortlists out of reach.
// We don't forbid replace outright (profile intake legitimately rewrites these
// while GROWING them); we block only a replace that SHRINKS the note past half —
// the actual clobber signature — and point the agent at section/append.
const LOAD_BEARING_SLOTS = new Set(["profile.md", "resume.md"]);
const CLOBBER_MIN_EXISTING = 300; // only guard slots that hold real content
const CLOBBER_SHRINK_RATIO = 0.5; // replace dropping below half = likely clobber

export const writeMemoryTool: ToolDef<{
  path: string;
  content: string;
  mode?: "replace" | "append";
  section?: string;
}> = {
  affectsViewedState: true,
  name: "write_memory",
  description:
    'Write a memory note. To UPDATE part of an existing note (especially profile.md / resume.md), pass `section` = the `##` heading you\'re changing and `content` = the new text for just that section — every other section is preserved. Use `mode: "append"` to add to the end. A plain `replace` (the default) overwrites the WHOLE note; on a profile note it will be refused if it would discard most of the existing content (use section/append instead).',
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Memory path (see read_memory for allowed patterns).",
      },
      content: {
        type: "string",
        description:
          "Markdown content to write. With `section`, this is the body for that one section (the `## heading` line is added for you).",
      },
      mode: {
        type: "string",
        enum: ["replace", "append"],
        description:
          "Default 'replace' (overwrites the whole note). 'append' adds to the end. To edit one section without touching the rest, use `section` instead of either.",
      },
      section: {
        type: "string",
        description:
          "The `##` heading to replace/insert (e.g. 'What I care about most'). Replaces just that section and keeps the others — the safe way to update a profile note. Adds the section if it doesn't exist yet.",
      },
    },
    required: ["path", "content"],
  },
  parser: z.object({
    path: z.string(),
    content: z.string(),
    mode: z.enum(["replace", "append"]).optional(),
    section: z.string().optional(),
  }),
  async handle({ path, content, mode, section }, ctx) {
    if (section?.trim()) {
      const r = await mergeMemorySection(ctx.userId, path, section, content);
      return {
        content: `merged section "${section.trim()}" into ${path}${r.matched ? "" : " (new section)"}`,
      };
    }
    if (mode === "append") {
      await appendMemory(ctx.userId, path, content);
      return { content: `appended to ${path}` };
    }
    // Whole-file replace. Guard the load-bearing profile slots against a clobber
    // — a replace that drops the note below half its current size discards most
    // of the user's profile (the bug this guards). Point the agent at the safe
    // section/append paths instead of silently destroying content.
    if (LOAD_BEARING_SLOTS.has(path)) {
      const existing = (await readMemory(ctx.userId, path)) ?? "";
      const existingLen = existing.trim().length;
      const newLen = content.trim().length;
      if (
        existingLen >= CLOBBER_MIN_EXISTING &&
        newLen < existingLen * CLOBBER_SHRINK_RATIO
      ) {
        return toolError(
          "GATE_BLOCKED",
          `Refusing this write: it would replace ${path} (${existingLen} chars of the user's profile) with much less (${newLen} chars), discarding most of what's there — a shrink this large usually means an accidental whole-note overwrite. To UPDATE one part, call write_memory again with section:"<the ## heading you're changing>" and content = the new text for just that section (the rest is preserved). To ADD, use mode:"append". If you genuinely intend a full rewrite, read_memory ${path} first and include everything you want to keep in content.`,
          "write_memory:guard:load_bearing_shrink",
        );
      }
    }
    await writeMemory(ctx.userId, path, content);
    return { content: `wrote ${path}` };
  },
};
