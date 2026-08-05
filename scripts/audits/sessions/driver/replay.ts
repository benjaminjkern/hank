// Replay a persisted Hank session into per-turn structured snapshots —
// the read-side equivalent of qa-audit/driver/turnDriver.ts (which projects
// a LIVE LoopEvent stream). For a real ChatSession, the source is the
// persisted ChatMessage.content array of typed blocks (text / tool_use /
// tool_result / pipeline_status / pipeline_widget / ui) plus the
// ChatMessage.traces field for sub-agent activity.
//
// Each AuditTurn groups one USER message together with every ASSISTANT
// and TOOL message that followed before the next USER message. This is
// the unit the user perceives as "one turn" — what they typed, then
// everything Hank did before stopping for their next input.

import { buildRenderedWidget } from "@/../scripts/regression/conversations/driver/widgetRender";
import type { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/client";
import type { WidgetKind } from "@/lib/widgetKinds";
import { detectFabricatedUiRender } from "@/server/agent/session/uiProvenance";
import {
  parseToolErrorMarker,
  stripToolErrorMarker,
} from "@/server/agent/tools/lib/toolError";

// Each persisted ChatMessage.content block is one of these. Reflects the
// shape Hank's streamingCore persists via mergeAssistantSegments and
// friends. We don't import the upstream union to avoid widening the
// build graph; instead we accept `unknown` and narrow defensively.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    }
  | { type: "pipeline_status"; text: string }
  | {
      type: "pipeline_widget";
      kind: WidgetKind;
      payload: unknown;
      toolUseId?: string;
    }
  | { type: "run_error"; detail: string }
  | { type: "tool_use_progress"; toolUseId: string; label?: string }
  | { type: "ui"; payload?: unknown }
  | { type: "thinking"; thinking?: string }
  | { type: "server_tool_use"; id: string; name: string; input?: unknown };

export type ToolCall = {
  toolUseId: string;
  name: string;
  input: unknown;
  // Joined from the next TOOL message's matching tool_result block.
  // `null` means the pair is orphaned (stopped mid-stream or summarised away).
  // `code`/`dedupHint` are parsed from the HANK-354 `<!--tool-error:{…}-->`
  // marker when present (newer rows); absent on legacy rows.
  result: {
    text: string;
    isError: boolean;
    code?: string;
    dedupHint?: string;
  } | null;
};

export type RunTrace = {
  toolUseId: string; // the parent tool_use this trace hangs off
  // Recursive subset of the persisted trace shape — kept as raw JSON for
  // the perception layer to format.
  raw: unknown;
};

export type AuditTurn = {
  turnIndex: number; // 0-based across the audited window
  userMessageId: string | null; // null only for the leading-tail case where the audit starts mid-turn
  userMessageAt: Date | null;
  userText: string; // verbatim, includes widget-response markers if any
  assistantMessageIds: string[]; // all ASSISTANT message ids in this turn

  // --- Visible to the user --------------------------------------------
  assistantText: string;
  statusLines: string[];
  toolChipsTopLevel: string[]; // collapsed chips; sub-agent calls hidden under traces
  widgets: Array<{
    kind: WidgetKind;
    rendered: string | null;
    renderError?: string;
    rawPayload: unknown;
  }>;
  panelHint: string; // crude: last UI/focus state observed in window (or "" if unchanged)
  stoppedByUser: boolean;
  errorEvent: { code?: string; message?: string } | null;
  // Out-of-chat but user-visible surface — the full drafted cover letter /
  // short answers, recent-activity events, company/job notes + descriptions,
  // and memory/document files the user can see in the right panel / Documents
  // view but that never appear in chat. Reconstructed from CURRENT DB state at
  // audit time, keyed off the entities this turn's toolcalls/workflow touched
  // (see driver/entitySnapshots.ts). Undefined when the turn touched no entity.
  entitySnapshot?: string;

  // --- Raw correctness signal -----------------------------------------
  toolCalls: ToolCall[]; // top-level only — sub-agent tool calls live in traces
  subAgentTraces: RunTrace[];

  // --- Heuristic flags computed deterministically ---------------------
  // Lifted to the auditor's input so it can lean on them OR refute them.
  flags: string[];
};

const INTERNAL_LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Enum leaks in assistant text
  {
    name: "enum_leak",
    re: /\b(CAUGHT_UP|SHORTLISTED|SCANNED|CLOSED|DELISTED|DEFERRED|APPLIED|RESPONDED|INTERVIEW_(SCHEDULED|DEBRIEF)|OFFERED|REJECTED|PITCHED|READY|APPLYING|IN_FLIGHT|IN_PROCESS|PAUSED|BLOCKED|NEW)\b/,
  },
  {
    name: "skip_reason_leak",
    re: /\b(NOT_A_MATCH|LOCATION_MISMATCH|CANNOT_SCRAPE|OUTRANKED|WITHDRAWN)\b/,
  },
  {
    name: "pause_reason_leak",
    re: /\bUSER_PAUSED\b/,
  },
  {
    name: "tool_name_leak",
    re: /\b(search_jobs|propose_shortlist_auto|compact_chat|set_focus|whats_next|get_application_form|draft_application|update_jobs_status|update_company_status|log_event|record_observation|company_walkthrough|add_to_watchlist|create_opportunity|discover_companies)\b/,
  },
  {
    name: "memory_path_leak",
    re: /\b(users\/me\.md|overall\.md|frequent_questions\.md|companies\/[\w-]+\.md|jobs\/[\w-]+\.md|contacts\/[\w-]+\.md)\b/,
  },
  {
    name: "model_framing_leak",
    re: /\b(Claude|Sonnet|Haiku|Opus|Fable|context window|token budget|compaction)\b/i,
  },
  { name: "id_leak", re: /\bcm[a-z0-9]{22,}\b/ }, // bare cuids in assistant text
];

function blocksOf(content: Prisma.JsonValue): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => !!b && typeof b === "object" && !Array.isArray(b) && "type" in b,
  ) as unknown as ContentBlock[];
}

function textOfBlock(b: ContentBlock): string {
  if (b.type === "text" && typeof b.text === "string") return b.text;
  return "";
}

function tool_result_text(b: ContentBlock & { type: "tool_result" }): string {
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) {
    return b.content
      .map((c) =>
        c &&
        typeof c === "object" &&
        "text" in c &&
        typeof (c as { text?: string }).text === "string"
          ? (c as { text: string }).text
          : `[${(c as { type?: string }).type ?? "?"}]`,
      )
      .join("\n");
  }
  return "";
}

function scanLeaks(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of INTERNAL_LEAK_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(`${name}:${m[0]}`);
  }
  return hits;
}

type MessageRow = {
  id: string;
  role: Role;
  createdAt: Date;
  content: Prisma.JsonValue;
  traces: Prisma.JsonValue;
  stoppedByUser: boolean;
};

export function projectTurns(messages: MessageRow[]): AuditTurn[] {
  const turns: AuditTurn[] = [];
  let cur: AuditTurn | null = null;
  let turnIndex = 0;

  const userTextFrom = (m: MessageRow): string => {
    const blocks = blocksOf(m.content);
    return blocks.map(textOfBlock).filter(Boolean).join("\n").trim();
  };

  for (const m of messages) {
    if (m.role === Role.USER) {
      if (cur) turns.push(cur);
      cur = {
        turnIndex: turnIndex++,
        userMessageId: m.id,
        userMessageAt: m.createdAt,
        userText: userTextFrom(m),
        assistantMessageIds: [],
        assistantText: "",
        statusLines: [],
        toolChipsTopLevel: [],
        widgets: [],
        panelHint: "",
        stoppedByUser: false,
        errorEvent: null,
        toolCalls: [],
        subAgentTraces: [],
        flags: [],
      };
      continue;
    }

    // If the session starts mid-turn (no USER yet), open a synthetic turn so we
    // still capture the trailing state. Skipped if there's nothing to absorb.
    if (!cur) {
      cur = {
        turnIndex: turnIndex++,
        userMessageId: null,
        userMessageAt: null,
        userText:
          "(no user message — leading tail before first USER row in window)",
        assistantMessageIds: [],
        assistantText: "",
        statusLines: [],
        toolChipsTopLevel: [],
        widgets: [],
        panelHint: "",
        stoppedByUser: false,
        errorEvent: null,
        toolCalls: [],
        subAgentTraces: [],
        flags: [],
      };
    }

    if (m.role === Role.ASSISTANT) {
      cur.assistantMessageIds.push(m.id);
      cur.stoppedByUser = cur.stoppedByUser || m.stoppedByUser;
      const blocks = blocksOf(m.content);
      const seenTopLevelTools = new Set(cur.toolChipsTopLevel);
      for (const b of blocks) {
        switch (b.type) {
          case "text": {
            const txt = textOfBlock(b);
            if (txt) cur.assistantText += (cur.assistantText ? "\n" : "") + txt;
            break;
          }
          case "tool_use": {
            const tu = b;
            if (!seenTopLevelTools.has(tu.name)) {
              seenTopLevelTools.add(tu.name);
              cur.toolChipsTopLevel.push(tu.name);
            }
            cur.toolCalls.push({
              toolUseId: tu.id,
              name: tu.name,
              input: tu.input,
              result: null,
            });
            break;
          }
          case "pipeline_status":
            if (typeof (b as { text?: string }).text === "string")
              cur.statusLines.push((b as { text: string }).text);
            break;
          case "run_error":
            // The run threw and the user is looking at an error row instead of
            // the rest of the turn. Everything the turn was mid-way through is
            // absent BECAUSE of this, so the auditor has to see it — otherwise a
            // failed turn grades as Hank inexplicably going quiet.
            if (typeof (b as { detail?: string }).detail === "string")
              cur.errorEvent = { message: (b as { detail: string }).detail };
            break;
          case "pipeline_widget": {
            const w = b;
            try {
              const rendered = buildRenderedWidget(w.kind, w.payload);
              if (rendered) {
                cur.widgets.push({
                  kind: w.kind,
                  rendered: rendered.text,
                  rawPayload: w.payload,
                });
              } else {
                cur.widgets.push({
                  kind: w.kind,
                  rendered: null,
                  renderError:
                    "buildRenderedWidget returned null (unknown widget kind to the renderer)",
                  rawPayload: w.payload,
                });
              }
            } catch (e) {
              cur.widgets.push({
                kind: w.kind,
                rendered: null,
                renderError: e instanceof Error ? e.message : String(e),
                rawPayload: w.payload,
              });
            }
            break;
          }
          default:
            // tool_use_progress, ui, server_tool_use, thinking — not in the
            // user-visible surface or already handled elsewhere.
            break;
        }
      }
      // Traces hang off the assistant message that spawned them.
      if (m.traces && typeof m.traces === "object") {
        // The shape: { [toolUseId]: { steps: TraceStep[] } } — pass through.
        for (const [toolUseId, raw] of Object.entries(
          m.traces as Record<string, unknown>,
        )) {
          cur.subAgentTraces.push({ toolUseId, raw });
        }
      }
    } else if (m.role === Role.TOOL) {
      const blocks = blocksOf(m.content);
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const tr = b;
        const rawText = tool_result_text(tr);
        // HANK-354: the structured code/dedupHint travels in an inert marker
        // baked into the content. Parse it (the reliable signal), strip it for
        // a clean prose display, and keep the legacy `/^ERR /` heuristic as a
        // fallback for pre-354 rows.
        const marker = parseToolErrorMarker(rawText);
        const text = stripToolErrorMarker(rawText);
        const isError =
          tr.is_error === true || marker !== null || /^ERR /.test(text);
        const target = cur.toolCalls.find(
          (c) => c.toolUseId === tr.tool_use_id,
        );
        if (target) {
          target.result = {
            text,
            isError,
            ...(marker?.code ? { code: marker.code } : {}),
            ...(marker?.dedupHint ? { dedupHint: marker.dedupHint } : {}),
          };
        }
      }
    }
  }
  if (cur) turns.push(cur);

  // Compute leak flags after the turn is fully assembled.
  for (const t of turns) {
    if (t.assistantText) {
      // Exclude false positives where the user typed the term first.
      const userMentioned = (word: string) => t.userText.includes(word);
      for (const flag of scanLeaks(t.assistantText)) {
        const word = flag.split(":")[1];
        if (userMentioned(word)) continue;
        t.flags.push(`leak:assistant:${flag}`);
      }
      // Confabulated on-screen surface: Hank typed out a role menu / shortlist /
      // picker in prose (or echoed the <system-reminder> operator marker) instead
      // of letting the system render it. The Block-roles failure class. Hard hits
      // are always a bug; fuzzy hits are widget-shaped prose worth the auditor's
      // eyes.
      const fab = detectFabricatedUiRender(t.assistantText);
      for (const r of fab.reasons) {
        t.flags.push(`confabulated_ui:${r.tier}:${r.id}`);
      }
    }
    for (const w of t.widgets) {
      if (w.renderError)
        t.flags.push(
          `widget:render_error:${w.kind}:${w.renderError.slice(0, 60)}`,
        );
      if (w.rendered) {
        for (const flag of scanLeaks(w.rendered))
          t.flags.push(`leak:widget:${w.kind}:${flag}`);
      }
    }
    // Status-line leaks: more lenient (some enum text by design), but flag bare paths/cuids
    for (const line of t.statusLines) {
      for (const flag of scanLeaks(line).filter(
        (f) => f.startsWith("id_leak") || f.startsWith("memory_path_leak"),
      )) {
        t.flags.push(`leak:status:${flag}`);
      }
    }
    // Orphan tool calls (no matching tool_result) — usually means streaming
    // was interrupted; the system handles these via repairOrphanToolUses but
    // they're still a turn-quality signal.
    const orphans = t.toolCalls.filter((c) => c.result === null);
    if (orphans.length > 0)
      t.flags.push(
        `orphan_tool_calls:${orphans.length}:${orphans.map((o) => o.name).join(",")}`,
      );
    // Tool errors — explicit hook so the auditor can correlate them with its silent-workaround check.
    // Carry the tool-error code (where present) so the chunk-level flag is groupable.
    const errors = t.toolCalls.filter((c) => c.result?.isError);
    if (errors.length > 0)
      t.flags.push(
        `tool_errors:${errors.length}:${errors
          .map((e) => (e.result?.code ? `${e.name}(${e.result.code})` : e.name))
          .join(",")}`,
      );
  }

  return turns;
}
