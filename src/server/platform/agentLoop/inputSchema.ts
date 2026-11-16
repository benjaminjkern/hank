// A tool's model-facing JSON schema, derived from its zod `parser` — the parser
// is the tool's ONLY schema. Field prose for the model goes on the zod node with
// `.describe(…)`; what the model sees and what the handler accepts can't drift
// because they're the same object.
//
// `io: "input"` because the model writes the INPUT side: a `z.preprocess` or
// `.transform` shows the shape it accepts, not what it becomes.

import { z } from "zod";

import type { AnyToolDef } from "./tool";
import type Anthropic from "@anthropic-ai/sdk";

const cache = new WeakMap<AnyToolDef, Anthropic.Tool["input_schema"]>();

export function toolInputSchema(
  tool: AnyToolDef,
): Anthropic.Tool["input_schema"] {
  const hit = cache.get(tool);
  if (hit) return hit;
  const raw = z.toJSONSchema(tool.parser, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  // Noise the API doesn't need: the draft URI, and the ±2^53 bounds zod writes
  // for every `.int()`.
  delete raw.$schema;
  const schema = JSON.parse(
    JSON.stringify(raw, (key, value: unknown) =>
      (key === "maximum" && value === Number.MAX_SAFE_INTEGER) ||
      (key === "minimum" && value === Number.MIN_SAFE_INTEGER)
        ? undefined
        : value,
    ),
  ) as Anthropic.Tool["input_schema"];
  if (schema.type !== "object") {
    throw new Error(
      `tool ${tool.name}: parser must be a z.object (the API requires an object input schema)`,
    );
  }
  cache.set(tool, schema);
  return schema;
}
