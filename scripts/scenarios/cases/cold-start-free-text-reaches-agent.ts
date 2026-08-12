import { runUserMessage } from "@/server/agent/runtime/runUserMessage";
import { prisma } from "@/server/db/prisma";

import { TEST_SESSION_ID, USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "cold-start-free-text-reaches-agent",
  cost: "expensive",
  describe:
    "Free text on a fresh session must reach Hank, not get swallowed by the deterministic layer. This used to be a currentFlow concern (the cold-start branch wrote currentFlow='walkthrough' so a runner existed to field the message); with one runner and no persisted flow the risk is different but still real — runChatTurn's Path 1 (state machine, no agent turn) must NOT capture a turn that carries a user message. The picker may still render after the agent wraps (normal post-wrap flow), so we don't assert against it — we assert the agent actually ran.",
  async run() {
    const notes: string[] = [];
    try {
      const events: { type: string; kind?: string; text?: string }[] = [];
      for await (const ev of runUserMessage({
        userId: USER_ID,
        userMessage: "hey what's up",
        attachmentIds: [],
        sessionIdOverride: TEST_SESSION_ID,
      })) {
        if (ev.type === "pipeline_widget")
          events.push({ type: "widget", kind: ev.kind });
        else if (ev.type === "text")
          events.push({ type: "text", text: ev.text });
        else events.push({ type: ev.type });
      }
      // Hank should have emitted at least one text token — proves the message
      // reached the agent rather than only the deterministic layer.
      const sawAgentText = events.some(
        (e) => e.type === "text" && !!e.text && e.text.trim().length > 0,
      );
      notes.push(`agent emitted text: ${sawAgentText} (expected true)`);
      return { ok: sawAgentText, notes };
    } finally {
      await prisma.chatMessage.deleteMany({
        where: { sessionId: TEST_SESSION_ID },
      });
    }
  },
};

export default scenario;
