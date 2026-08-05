import Anthropic from "@anthropic-ai/sdk";

import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { NoAnthropicKeyError } from "@/server/platform/llm/resolveClient";
import {
  classifyMime,
  MAX_FILE_SIZE,
} from "@/server/platform/storage/attachments";
import {
  DOCX_MIME,
  extractDocxText,
  isDocxUpload,
} from "@/server/platform/storage/docx";
import { mergeResumeIntoBackground } from "@/server/procedures/registry/attachResumeToProfile";
import type { ParseResumeInput } from "@/server/subagents/registry/parseResume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Direct resume upload from the Documents page. This route owns only the file
// handling — PDF passes straight through, .docx is extracted to text first (and
// stored as that text, matching the Resume.fileBytes convention) — then hands off
// to the same mergeResumeIntoBackground chain the agent's attach_resume_to_profile
// tool uses, so an upload folds into the background identically either way.
// Parsing is an Anthropic vision call, so this route owns its own error
// classification: it does NOT route through /api/chat, where the apiKeyBlocker
// modal is wired up.
export async function POST(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return Response.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing 'file' field" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: `file too large (${file.size} > ${MAX_FILE_SIZE} bytes)` },
      { status: 413 },
    );
  }

  const rawBytes = new Uint8Array(await file.arrayBuffer());

  try {
    let source: ParseResumeInput["source"];
    let fileMime = file.type;
    let storeBytes = rawBytes;

    if (isDocxUpload(file.type, file.name)) {
      let text: string;
      try {
        text = await extractDocxText(rawBytes);
      } catch (err) {
        return Response.json(
          {
            error: `could not read ${file.name} as a Word document: ${(err as Error).message}`,
          },
          { status: 415 },
        );
      }
      source = { kind: "text", text };
      fileMime = DOCX_MIME;
      storeBytes = new TextEncoder().encode(text);
    } else if (classifyMime(file.type) === "pdf") {
      source = { kind: "pdf", bytes: rawBytes };
    } else {
      return Response.json(
        {
          error: `unsupported file type "${file.type || file.name}". Upload a PDF or .docx resume.`,
        },
        { status: 415 },
      );
    }

    const result = await mergeResumeIntoBackground({
      userId: user.id,
      fileName: file.name,
      fileMime,
      storeBytes,
      source,
    });
    // An unparseable résumé is fatal — there's nothing to save.
    if (!result.ok) throw new Error(result.error);

    return Response.json({
      ok: true,
      fileName: file.name,
      merged: result.merged,
    });
  } catch (err) {
    if (err instanceof NoAnthropicKeyError) {
      return Response.json(
        { error: "Add an Anthropic API key in Settings to parse a resume." },
        { status: 400 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      return Response.json(
        {
          error: `Resume parse failed (${err.status ?? "?"}). Please try again.`,
        },
        { status: 400 },
      );
    }
    return Response.json(
      { error: (err as Error)?.message ?? "resume parse failed" },
      { status: 500 },
    );
  }
}
