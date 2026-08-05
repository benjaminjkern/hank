import { prisma } from "@/server/db/prisma";

type MediaKind = "pdf" | "image" | "text";

const PDF_MIMES = new Set(["application/pdf"]);
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export function classifyMime(mime: string): MediaKind | null {
  if (PDF_MIMES.has(mime)) return "pdf";
  if (IMAGE_MIMES.has(mime)) return "image";
  if (TEXT_MIMES.has(mime) || mime.startsWith("text/")) return "text";
  return null;
}

export async function createAttachment(args: {
  userId: string;
  fileName: string;
  fileMime: string;
  fileBytes: Uint8Array;
  mediaKind: MediaKind;
}) {
  const bytes = args.fileBytes as Uint8Array<ArrayBuffer>;
  return await prisma.attachment.create({
    data: {
      userId: args.userId,
      fileName: args.fileName,
      fileMime: args.fileMime,
      fileBytes: bytes,
      fileSize: bytes.byteLength,
      mediaKind: args.mediaKind,
    },
    select: {
      id: true,
      fileName: true,
      fileMime: true,
      fileSize: true,
      mediaKind: true,
    },
  });
}

export async function getAttachment(id: string, userId: string) {
  return await prisma.attachment.findFirst({
    where: { id, userId },
  });
}

// Batch form of getAttachment — one query for a whole message's attachments.
// Returns in whatever order Postgres gives them; the caller re-orders by id.
export async function listAttachmentsByIds(ids: string[], userId: string) {
  if (ids.length === 0) return [];
  return await prisma.attachment.findMany({
    where: { id: { in: ids }, userId },
  });
}

export async function linkAttachmentsToMessage(
  messageId: string,
  attachmentIds: string[],
  sessionId: string,
  userId: string,
) {
  if (attachmentIds.length === 0) return;
  await prisma.attachment.updateMany({
    where: { id: { in: attachmentIds }, userId },
    data: { messageId, sessionId },
  });
}

export async function listAttachmentsForMessages(messageIds: string[]) {
  if (messageIds.length === 0)
    return [] as Array<{
      id: string;
      messageId: string | null;
      fileName: string;
      mediaKind: string;
    }>;
  return await prisma.attachment.findMany({
    where: { messageId: { in: messageIds } },
    select: {
      id: true,
      messageId: true,
      fileName: true,
      mediaKind: true,
    },
  });
}
