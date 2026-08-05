import { z } from "zod";

import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import {
  isEditableDocKind,
  saveUserDoc,
} from "@/server/entities/narrativeDocs";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  doc: z.string(),
  content: z.string(),
});

// Write path for the three editable documents (profile / frequent questions /
// resume framing notes). `doc` is validated against the allowlist
// in documents.ts — arbitrary memory paths are not reachable from here.
export async function PUT(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!isEditableDocKind(parsed.data.doc)) {
    return Response.json(
      { error: `not an editable document: ${parsed.data.doc}` },
      { status: 400 },
    );
  }

  await saveUserDoc(user.id, parsed.data.doc, parsed.data.content);
  return Response.json({ ok: true });
}
