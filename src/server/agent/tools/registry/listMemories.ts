import { z } from "zod";

import { listMemories } from "@/server/memory/store";

import type { ToolDef } from "../lib/types";

export const listMemoriesTool: ToolDef<{ prefix?: string }> = {
  name: "list_memories",
  description:
    "List memory paths for the current user. Optional prefix filter (e.g. 'companies/').",
  inputSchema: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        description: "Optional path prefix to filter by.",
      },
    },
  },
  parser: z.object({ prefix: z.string().optional() }),
  async handle({ prefix }, ctx) {
    const paths = await listMemories(ctx.userId, prefix);
    return { content: paths.length ? paths.join("\n") : "(no memory notes)" };
  },
};
