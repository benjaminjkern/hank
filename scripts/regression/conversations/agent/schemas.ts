// Forced-tool schemas for the persona agent. Each turn the persona is forced
// to call persona_turn (think out loud → one action → assess → maybe halt).
// At the end it is forced to call persona_wrapup (overall take + terse lossless
// summary including every thought log).

import type Anthropic from "@anthropic-ai/sdk";

export const HALT_CATEGORIES = [
  "crash_error",
  "broken_widget",
  "looping_stuck",
  "internal_vocab_leak",
  "contradiction",
  "nonsensical",
] as const;

export type HaltCategory = (typeof HALT_CATEGORIES)[number];

// NOTE: kept deliberately FLAT (no nested 'action' object). An earlier nested
// shape caused the model to occasionally serialize the action object as a
// malformed string, dropping action.type. Flat top-level fields parse reliably.
export type PersonaTurnInput = {
  thoughts: string;
  actionType: "send_message" | "widget_action";
  message?: string;
  optionRef?: string | number;
  selection?: (string | number)[];
  widgetNote?: string;
  goalProgress: "achieved" | "advancing" | "stalled" | "blocked";
  assessment: { onTrack: boolean; notes: string };
  halt: { triggered: boolean; category?: HaltCategory; evidence?: string };
};

export type PersonaWrapupInput = {
  overallPerspective: string;
  terseLosslessSummary: string;
};

export const personaTurnTool: Anthropic.Tool = {
  name: "persona_turn",
  description:
    "Record your thinking, take exactly one action as the user, assess how Hank is doing, and raise a halt if something is seriously wrong. You MUST call this every turn.",
  input_schema: {
    type: "object",
    properties: {
      thoughts: {
        type: "string",
        description:
          "Think out loud AS THE USER: what you see, how it lands, whether it matches what you asked for, what you'll do next and why. Keep it to a few sentences. This is your private chain-of-thought log.",
      },
      actionType: {
        type: "string",
        enum: ["send_message", "widget_action"],
        description:
          "Your one action this turn. send_message = type a chat message (use when there is NO widget on screen). widget_action = interact with the widget currently shown (ONLY valid when a widget is present).",
      },
      message: {
        type: "string",
        description:
          "The chat message text. Required when actionType=send_message.",
      },
      optionRef: {
        type: ["string", "number"],
        description:
          "For widget_action on a single-choice widget: the option reference exactly as shown in 'How to respond to this'.",
      },
      selection: {
        type: "array",
        items: { type: ["string", "number"] },
        description:
          "For widget_action on a multi-select widget (shortlist / company checklist): the list of item numbers you choose. Use [] to choose none.",
      },
      widgetNote: {
        type: "string",
        description:
          "Optional text typed into a widget that has a text field (currently only the shortlist's reason note). Leave unset for widgets without one.",
      },
      goalProgress: {
        type: "string",
        enum: ["achieved", "advancing", "stalled", "blocked"],
        description:
          "Where you are on YOUR persona's goal. 'achieved' ends the conversation after this turn.",
      },
      assessment: {
        type: "object",
        properties: {
          onTrack: {
            type: "boolean",
            description: "Is Hank behaving sensibly for what you asked?",
          },
          notes: {
            type: "string",
            description: "Brief QA assessment of Hank's behavior this turn.",
          },
        },
        required: ["onTrack", "notes"],
      },
      halt: {
        type: "object",
        description:
          "Raise this ONLY for something MAJOR that a real user could not work around: a crash/error, a broken or un-actionable widget, Hank looping or stuck, internal jargon/ids/enums leaking into chat, Hank contradicting an earlier turn, or a reply that's nonsensical for what you asked. A halt stops the entire experiment so the bug can be fixed.",
        properties: {
          triggered: { type: "boolean" },
          category: { type: "string", enum: [...HALT_CATEGORIES] },
          evidence: {
            type: "string",
            description:
              "Concrete quote/description of what went wrong and why it's major.",
          },
        },
        required: ["triggered"],
      },
    },
    required: ["thoughts", "actionType", "goalProgress", "assessment", "halt"],
  },
};

export const personaWrapupTool: Anthropic.Tool = {
  name: "persona_wrapup",
  description:
    "Close out the conversation. Give your overall perspective as the user, then a terse but LOSSLESS summary of the whole session.",
  input_schema: {
    type: "object",
    properties: {
      overallPerspective: {
        type: "string",
        description:
          "Your holistic take as this persona: did Hank help you reach your goal? What worked, what was rough, would you trust it?",
      },
      terseLosslessSummary: {
        type: "string",
        description:
          "Dense, lossless recap of the ENTIRE session: every turn's thought log, the actions you took, the widgets you saw, every assessment, and the halt if any. Terse phrasing, but drop no information.",
      },
    },
    required: ["overallPerspective", "terseLosslessSummary"],
  },
};
