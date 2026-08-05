import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import {
  classifyMime,
  createAttachment,
  MAX_FILE_SIZE,
} from "@/server/platform/storage/attachments";
import {
  DOCX_MIME,
  extractDocxText,
  isDocxUpload,
} from "@/server/platform/storage/docx";

export const runtime = "nodejs";

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

  const ab = await file.arrayBuffer();
  let bytes = new Uint8Array(ab);
  let fileMime = file.type;
  let mediaKind = classifyMime(file.type);

  if (isDocxUpload(file.type, file.name)) {
    // Claude can't read .docx natively. Extract text via mammoth at upload
    // time and store the extracted UTF-8 as the attachment payload. The
    // original docx bytes are discarded — the user kept their copy.
    let extracted: string;
    try {
      extracted = await extractDocxText(bytes);
    } catch (err) {
      return Response.json(
        {
          error: `could not read ${file.name} as a Word document: ${(err as Error).message}`,
        },
        { status: 415 },
      );
    }
    bytes = new TextEncoder().encode(extracted);
    fileMime = DOCX_MIME;
    mediaKind = "text";
  }

  if (!mediaKind) {
    return Response.json(
      {
        error: `unsupported file type "${file.type || file.name}". We can read PDFs, Word docs (.docx), images (png/jpeg/gif/webp), and plain text.`,
      },
      { status: 415 },
    );
  }

  const att = await createAttachment({
    userId: user.id,
    fileName: file.name,
    fileMime,
    fileBytes: bytes,
    mediaKind,
  });

  return Response.json({
    attachmentId: att.id,
    fileName: att.fileName,
    fileMime: att.fileMime,
    fileSize: att.fileSize,
    mediaKind: att.mediaKind,
  });
}
