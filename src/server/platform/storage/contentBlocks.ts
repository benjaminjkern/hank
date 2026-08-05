import type Anthropic from "@anthropic-ai/sdk";

const TEXT_INLINE_CAP = 50 * 1024; // 50KB of decoded text per file

type AttachmentForBlock = {
  fileName: string;
  fileMime: string;
  fileBytes: Uint8Array | Buffer;
  mediaKind: string;
};

export function toAnthropicBlock(
  att: AttachmentForBlock,
): Anthropic.ContentBlockParam {
  const bytes =
    att.fileBytes instanceof Buffer
      ? att.fileBytes
      : Buffer.from(att.fileBytes);

  if (att.mediaKind === "pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: bytes.toString("base64"),
      },
    };
  }

  if (att.mediaKind === "image") {
    const mediaType = att.fileMime as
      "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: bytes.toString("base64"),
      },
    };
  }

  // text/* and application/json — decode as UTF-8, cap, wrap in text block
  const decoded = bytes.toString("utf8");
  const truncated = decoded.length > TEXT_INLINE_CAP;
  const body = truncated ? decoded.slice(0, TEXT_INLINE_CAP) : decoded;
  const suffix = truncated
    ? `\n\n[…truncated, ${decoded.length - TEXT_INLINE_CAP} more chars]`
    : "";
  return {
    type: "text",
    text: `<file name="${att.fileName}" mime="${att.fileMime}">\n${body}${suffix}\n</file>`,
  };
}
