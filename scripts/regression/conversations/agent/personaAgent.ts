// The persona agent: an Opus 4.8 model role-playing one user, driving a real
// multi-turn conversation with the live Hank pipeline. It only ever sees the
// text reconstruction of what a user would see (see perception.ts). Each turn
// it is forced to call persona_turn; at the end, persona_wrapup.

import Anthropic from "@anthropic-ai/sdk";

import { resolveAnthropicApiKey } from "@/server/platform/llm/resolveAnthropicKey";
import { recordUsage } from "@/server/platform/usage/track";

import { getGraderClient, graderBackend } from "../../../lib/graderLlm";
import { driveTurn, type VisibleTurn } from "../driver/turnDriver";

import { perceive } from "./perception";
import {
  personaTurnTool,
  personaWrapupTool,
  type PersonaTurnInput,
  type PersonaWrapupInput,
  type HaltCategory,
} from "./schemas";

import type { RenderedWidget } from "../driver/widgetRender";
import type { SpendAccountant } from "../lib/spend";
import type { Persona } from "../personas/types";

const MODEL = "claude-opus-4-8";
// Generous so a verbose 'thoughts' field plus the action/assessment/halt
// fields never truncate mid-JSON (which would drop required fields).
const MAX_TOKENS = 4096;

export type TurnRecord = {
  turn: number;
  perceived: string;
  harnessFlags: string[];
  thoughts: string;
  action: {
    type: string;
    message?: string;
    optionRef?: string | number;
    selection?: (string | number)[];
  };
  actionResolved: string; // what we actually sent to Hank (free text or marker label) / why it failed
  goalProgress: PersonaTurnInput["goalProgress"];
  assessment: PersonaTurnInput["assessment"];
  halt: PersonaTurnInput["halt"];
  visibleTurn: VisibleTurn;
  costSoFarUsd: number;
};

export type PersonaRunResult = {
  personaId: string;
  userId: string;
  sessionId: string;
  endReason: "achieved" | "max_turns" | "halt" | "spend_cap" | "error";
  halted: { category?: HaltCategory; evidence?: string; turn: number } | null;
  turns: TurnRecord[];
  wrapup: PersonaWrapupInput | null;
  error?: string;
};

function buildSystem(persona: Persona): string {
  return [
    `You are role-playing a real person using "Hank", a chat assistant for finding and applying to jobs. Stay fully in character for the entire conversation.`,
    `You are a NORMAL first-time user. You have NEVER used this product, you do NOT know how it works under the hood, and you do NOT know any of its internal terminology — words like "watchlist", "shortlist", "walkthrough", "profile enrichment", "scan", or any feature/mode names are NOT in your head. You only know what you, a job-seeker, are trying to accomplish. Discover the product as you go; never assume a step it hasn't shown you or describe its mechanics back to it.`,
    ``,
    `# Who you are`,
    `Name: ${persona.displayName}`,
    `${persona.bio}`,
    ``,
    `# What you're trying to get done`,
    persona.goals.map((g) => `- ${g}`).join("\n"),
    ``,
    `# How you behave`,
    persona.constraints.map((c) => `- ${c}`).join("\n"),
    ``,
    `# Ground rules`,
    `- You can only see what's on screen: the assistant's chat replies, any on-screen control/form (shown to you as text), and a one-line hint about what's in the side panel. React only to what you actually see.`,
    `- Behave like a real person, NOT a patient power user. Don't do the assistant's job for it, don't smooth over problems, and don't invent workarounds it didn't offer. If it's slow, repetitive, confusing, or won't let you do the simple thing you asked, get annoyed and push back — and if it's bad enough, give up (halt).`,
    `- NORMAL on-screen furniture (NOT bugs): a small "(Hank worked on: …)" line and short "· …" status lines — every user sees these; largely ignore them.`,
    `- A genuine problem worth flagging is developer jargon inside the assistant's actual CHAT SENTENCES to you — status codes, internal feature/mode names, file paths, or made-up implementation phrases like "enrichment cycle". The tool/status furniture above does NOT count.`,
    `- Each turn you take EXACTLY ONE action. When a control/form is on screen you have three ways to use it, like a real user:`,
    `    1. Press a button / tick options — actionType="widget_action" with optionRef (single choice) or selection (the numbers, for multi-select). Follow the "How to respond to this" line.`,
    `    2. Type into its text field if it has one — set widgetNote along with your selection.`,
    `    3. Ignore it and just type a normal message — actionType="send_message" (this dismisses the control, like typing instead of clicking).`,
    `   When there's no control on screen, send_message is your only action. Use whichever a real person would — usually the on-screen control when it does what you want.`,
    `- Think out loud every turn in 'thoughts': what you see, how it lands, what you'll do next.`,
    `- Set goalProgress honestly. "achieved" once you've actually gotten what you came for (that ends the session). "blocked" when you're stuck and can't make progress.`,
    ``,
    `# When to HALT (stops the whole test so the issue gets fixed)`,
    `Raise a halt for anything MAJOR a real user could not work around or would rightly call broken:`,
    `- an error/crash, or a broken/unusable control;`,
    `- the assistant LOOPING, STALLING, repeating itself, making you repeat yourself, or NOT LETTING YOU FINISH a basic step you clearly asked for — e.g. it keeps asking for more, or won't proceed, after you've already given what it needs. Being trapped or unable to complete a simple task is bad UX: halt it;`,
    `- developer jargon inside the assistant's actual chat sentences (per above);`,
    `- the assistant contradicting itself across turns, or a reply that's nonsensical for what you asked.`,
    `Don't halt for minor wording awkwardness — note that in your assessment. But DO halt when the experience would make a real user give up.`,
  ].join("\n");
}

function extractToolInput<T>(msg: Anthropic.Message, name: string): T | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === name) {
      return block.input as T;
    }
  }
  return null;
}

function lastToolUseId(msg: Anthropic.Message, name: string): string | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === name) return block.id;
  }
  return null;
}

export async function runPersona(args: {
  persona: Persona;
  userId: string;
  sessionId: string;
  maxTurns: number;
  spend: SpendAccountant;
  signal: AbortSignal;
  // Returns true if the run should stop before the next turn (spend cap).
  shouldAbort: () => boolean;
  onTurn?: (rec: TurnRecord) => void;
}): Promise<PersonaRunResult> {
  const { persona, userId, sessionId, maxTurns, spend, signal } = args;
  // Persona (Opus 4.8) runs on the API key or the Claude subscription (Agent
  // SDK) per graderBackend(). Only the API path needs an Anthropic key; the
  // subscription path authenticates via CLAUDE_CODE_OAUTH_TOKEN. Note this does
  // NOT affect Hank-under-test — driveTurn()'s runUserMessage calls still use
  // the API key from the parent process env.
  const onApi = graderBackend() === "api";
  const client = getGraderClient(
    onApi
      ? new Anthropic({ apiKey: await resolveAnthropicApiKey(userId) })
      : null,
  );
  const system = buildSystem(persona);

  const turns: TurnRecord[] = [];
  const messages: Anthropic.MessageParam[] = [];

  // Drive Hank's real cold-start (empty first message) so the persona sees
  // Hank's actual opening — its greeting and, once onboarding completes, the
  // real widgets it can press — rather than a synthetic stand-in.
  let visible = await driveTurn({ userId, sessionId, userMessage: "", signal });
  let perceived = perceive(visible, 0);
  let lastRendered: RenderedWidget | null = visible.widget?.rendered ?? null;

  messages.push({
    role: "user",
    content:
      `You just opened Hank for the first time. Your opening intent: ${persona.openingIntent}\n\n` +
      `Here's what's on screen:\n${perceived.text}` +
      (perceived.harnessFlags.length
        ? `\n\n(QA note — the harness mechanically detected: ${perceived.harnessFlags.join("; ")})`
        : "") +
      `\n\nWhat do you do?`,
  });

  const result: PersonaRunResult = {
    personaId: persona.id,
    userId,
    sessionId,
    endReason: "max_turns",
    halted: null,
    turns,
    wrapup: null,
  };

  let turnNo = 1;
  // Bound the number of consecutive invalid actions so a confused persona
  // can't spin forever without advancing Hank.
  let invalidStreak = 0;
  // The persona_turn tool_use that still needs a tool_result before the next
  // model call. Anthropic rejects a request whose history has a dangling
  // tool_use, so on every break path the wrap-up must satisfy this.
  let pendingToolUseId: string | null = null;

  while (turnNo <= maxTurns) {
    if (args.shouldAbort()) {
      result.endReason = "spend_cap";
      break;
    }

    let turnMsg: Anthropic.Message;
    try {
      turnMsg = await client.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          tools: [personaTurnTool],
          tool_choice: { type: "tool", name: "persona_turn" },
          messages,
        },
        { signal },
      );
    } catch (err) {
      result.endReason = "error";
      result.error = err instanceof Error ? err.message : String(err);
      break;
    }
    // Subscription-billed persona turns carry no marginal $ — skip the DB
    // usage write + the spend-cap accounting so subscription tokens don't get
    // priced as API dollars (which would falsely trip the run's spend cap).
    if (onApi) {
      await recordUsage({
        userId,
        operation: "qa_audit_persona",
        model: MODEL,
        usage: turnMsg.usage,
        sessionId,
        notes: `turn=${turnNo}`,
      });
      spend.addPersonaUsage(MODEL, turnMsg.usage);
    }

    const rawInput = extractToolInput<Partial<PersonaTurnInput>>(
      turnMsg,
      "persona_turn",
    );
    const toolUseId = lastToolUseId(turnMsg, "persona_turn");
    if (!rawInput || !toolUseId) {
      result.endReason = "error";
      result.error = `persona model did not emit a usable persona_turn tool call (stop_reason=${turnMsg.stop_reason})`;
      break;
    }
    // Defensive coercion: if the model truncated (stop_reason=max_tokens) the
    // tail fields can be missing. Fill safe defaults so one bad turn doesn't
    // crash the run; note it so it shows up in the report.
    const truncated = turnMsg.stop_reason === "max_tokens";
    const input: PersonaTurnInput = {
      thoughts: rawInput.thoughts ?? "(no thoughts recorded)",
      actionType: rawInput.actionType ?? "send_message",
      message: rawInput.message,
      optionRef: rawInput.optionRef,
      selection: rawInput.selection,
      widgetNote: rawInput.widgetNote,
      goalProgress: rawInput.goalProgress ?? "advancing",
      assessment: rawInput.assessment ?? {
        onTrack: true,
        notes: truncated ? "(assessment truncated)" : "",
      },
      halt: rawInput.halt ?? { triggered: false },
    };
    messages.push({ role: "assistant", content: turnMsg.content });
    pendingToolUseId = toolUseId;

    // Resolve the persona's action into a Hank-bound message (or an error to
    // feed back without advancing Hank).
    let userMessage: string | null = null;
    let actionResolved = "";
    if (input.actionType === "send_message") {
      const text = (input.message ?? "").trim();
      if (!text) {
        actionResolved = "INVALID: empty message";
      } else {
        userMessage = text;
        actionResolved = `message: ${text}`;
      }
    } else {
      // widget_action
      if (!lastRendered) {
        actionResolved = "INVALID: tried to use a widget but none is on screen";
      } else {
        const t = lastRendered.translate({
          optionRef: input.optionRef,
          selection: input.selection,
          note: input.widgetNote,
        });
        if ("error" in t) {
          actionResolved = `INVALID widget action: ${t.error}`;
        } else {
          userMessage = t.marker;
          actionResolved = `widget: ${t.marker.split("\n").slice(1).join(" ").trim() || "(submitted)"}`;
        }
      }
    }

    const validAction = userMessage !== null;

    // Record the turn BEFORE driving Hank (so a halt still captures it).
    const record: TurnRecord = {
      turn: turnNo,
      perceived: perceived.text,
      harnessFlags: perceived.harnessFlags,
      thoughts: input.thoughts,
      action: {
        type: input.actionType,
        message: input.message,
        optionRef: input.optionRef,
        selection: input.selection,
      },
      actionResolved,
      goalProgress: input.goalProgress,
      assessment: input.assessment,
      halt: input.halt,
      visibleTurn: visible,
      costSoFarUsd: spend.total(),
    };

    // Halt check — persona-raised OR a hard system error this turn.
    if (input.halt?.triggered) {
      turns.push(record);
      args.onTurn?.(record);
      result.endReason = "halt";
      result.halted = {
        category: input.halt.category,
        evidence: input.halt.evidence,
        turn: turnNo,
      };
      break;
    }

    if (input.goalProgress === "achieved" && validAction === false) {
      // Goal achieved with no further action needed — close out.
      turns.push(record);
      args.onTurn?.(record);
      result.endReason = "achieved";
      break;
    }

    if (!validAction) {
      invalidStreak++;
      turns.push(record);
      args.onTurn?.(record);
      if (invalidStreak >= 3) {
        result.endReason = "error";
        result.error = "persona produced 3 consecutive invalid actions";
        break;
      }
      // Feed the failure back as the tool_result; don't advance Hank.
      perceived = {
        text: `[Turn ${turnNo}] Your last action didn't go through — ${actionResolved.replace(/^INVALID:?\s*/, "")}.\n\nWhat the screen still shows:\n${perceived.text}`,
        harnessFlags: [],
      };
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: perceived.text,
          },
        ],
      });
      pendingToolUseId = null;
      turnNo++;
      continue;
    }
    invalidStreak = 0;

    // Drive Hank with the resolved action.
    visible = await driveTurn({
      userId,
      sessionId,
      userMessage: userMessage as string,
      signal,
    });
    await spend.syncHankCost([userId]);
    record.costSoFarUsd = spend.total();
    turns.push(record);
    args.onTurn?.(record);

    perceived = perceive(visible, turnNo);
    lastRendered = visible.widget?.rendered ?? null;

    // If the persona declared achieved this turn AND took a final action, end
    // after we've driven that action.
    if (input.goalProgress === "achieved") {
      result.endReason = "achieved";
      break;
    }

    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content:
            perceived.text +
            (perceived.harnessFlags.length
              ? `\n\n(QA note — the harness mechanically detected: ${perceived.harnessFlags.join("; ")})`
              : ""),
        },
      ],
    });
    pendingToolUseId = null;
    turnNo++;
  }

  // Wrap-up — always attempt, even on halt / cap / max_turns, unless the model
  // itself errored mid-call.
  if (result.endReason !== "error") {
    try {
      const closer =
        result.endReason === "halt"
          ? "You hit something major and are stopping here. "
          : result.endReason === "max_turns"
            ? "You're out of time for this session. "
            : result.endReason === "spend_cap"
              ? "The session is being wrapped up early. "
              : "You've finished what you came to do. ";
      const closeText = `${closer}Now close out with persona_wrapup.`;
      // If we broke mid-turn (halt / achieved-with-action / max-turns), the
      // last assistant message has a dangling persona_turn tool_use — the
      // closing message must be its tool_result, or Anthropic 400s.
      if (pendingToolUseId) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: pendingToolUseId,
              content: closeText,
            },
          ],
        });
      } else {
        messages.push({ role: "user", content: closeText });
      }
      const wrapMsg = await client.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          tools: [personaWrapupTool],
          tool_choice: { type: "tool", name: "persona_wrapup" },
          messages,
        },
        { signal },
      );
      if (onApi) {
        await recordUsage({
          userId,
          operation: "qa_audit_persona",
          model: MODEL,
          usage: wrapMsg.usage,
          sessionId,
          notes: "wrapup",
        });
        spend.addPersonaUsage(MODEL, wrapMsg.usage);
      }
      result.wrapup = extractToolInput<PersonaWrapupInput>(
        wrapMsg,
        "persona_wrapup",
      );
    } catch (err) {
      result.error = `wrapup failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return result;
}
