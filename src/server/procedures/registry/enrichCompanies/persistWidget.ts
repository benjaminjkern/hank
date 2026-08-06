// Put a widget on screen from a TOP-LEVEL dispatch.
//
// The walkthrough state machine has an outer buffer that collects its events
// and persists them; a top-level submission does not, so a widget yielded
// without its own assistant row streams once and vanishes on refresh. Writing
// the row here is what makes it survive.

import { Role } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import type {
  RunContext,
  TurnEvent,
  WidgetKind,
} from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";

export type WatchlistAddArgs = RunContext & { sessionId: string };

export async function* persistWidget(
  args: WatchlistAddArgs,
  kind: WidgetKind,
  payload: unknown,
): AsyncGenerator<TurnEvent> {
  const toolUseId = `pipeline-${kind}-${crypto.randomUUID()}`;
  await prisma.chatMessage.create({
    data: {
      sessionId: args.sessionId,
      role: Role.ASSISTANT,
      content: [
        { type: "pipeline_widget", toolUseId, kind, payload },
      ] as unknown as Prisma.InputJsonValue,
      runId: args.runId ?? null,
    },
  });
  yield { type: "widget", toolUseId, kind, payload };
}
