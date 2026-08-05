import { z } from "zod";

import { readMemory } from "@/server/memory/store";

import type { ToolDef } from "../lib/types";

export const readMemoryTool: ToolDef<{ path: string }> = {
  name: "read_memory",
  description:
    "Read a memory note by path. Returns the note's contents, or an empty string if it doesn't exist.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Memory path. Allowed: profile.md (everything durable about the user — thesis, constraints, voice, patterns), frequent_questions.md, resume.md (the user's background — every résumé they've uploaded, merged with what they've said in chat), companies/{slug}.md, jobs/{slug}.md, opportunities/{slug}.md, contacts/{name-slug}.md, daily/{YYYY-MM-DD}.md, weekly/{YYYY-WW}.md. Every entity is a slug, never an id.",
      },
    },
    required: ["path"],
  },
  parser: z.object({ path: z.string() }),
  async handle({ path }, ctx) {
    const content = await readMemory(ctx.userId, path);
    return { content: content ?? "" };
  },
};
