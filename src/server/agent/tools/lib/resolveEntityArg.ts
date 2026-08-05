// "Resolve the entity slug (or cuid) a tool was passed, else return an
// AMBIGUOUS_INPUT toolError" — the preamble that opened five job handlers and
// five job handlers and the company handlers verbatim. An omitted slug is always
// ambiguous (there's no default entity to fall back to). Each caller supplies
// its own per-tool ambiguity sentence + dedup source so the audit keys and
// model-facing messages stay tool-specific.

import {
  resolveJobBySlug,
  resolveCompanyBySlug,
} from "@/server/entities/resolveBySlug";

import { slugLookupError } from "./slugLookupError";
import { toolError } from "./toolError";

import type { ToolResult } from "./types";

type ResolveCtx = { userId: string };
type ResolveOpts = { source: string; ambiguousMessage: string };

type ResolveArgResult =
  { ok: true; id: string } | { ok: false; result: ToolResult };

export async function resolveJobArg(
  ctx: ResolveCtx,
  slugOrCuid: string | undefined,
  opts: ResolveOpts,
): Promise<ResolveArgResult> {
  if (slugOrCuid) {
    const r = await resolveJobBySlug(ctx.userId, slugOrCuid);
    if (!r.ok)
      return {
        ok: false,
        result: slugLookupError(r),
      };
    return { ok: true, id: r.value.id };
  }
  return {
    ok: false,
    result: toolError(
      "AMBIGUOUS_INPUT",
      opts.ambiguousMessage,
      `${opts.source}:ambiguous:no_job`,
    ),
  };
}

export async function resolveCompanyArg(
  ctx: ResolveCtx,
  slugOrCuid: string | undefined,
  opts: ResolveOpts,
): Promise<ResolveArgResult> {
  if (slugOrCuid) {
    const r = await resolveCompanyBySlug(ctx.userId, slugOrCuid);
    if (!r.ok)
      return {
        ok: false,
        result: slugLookupError(r),
      };
    return { ok: true, id: r.value.id };
  }
  return {
    ok: false,
    result: toolError(
      "AMBIGUOUS_INPUT",
      opts.ambiguousMessage,
      `${opts.source}:ambiguous:no_company`,
    ),
  };
}
