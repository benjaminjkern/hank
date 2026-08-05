import mammoth from "mammoth";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function isDocxUpload(mime: string, fileName: string): boolean {
  if (mime === DOCX_MIME) return true;
  // Some browsers send octet-stream for .docx — fall back to extension sniff.
  if (!mime || mime === "application/octet-stream") {
    return fileName.toLowerCase().endsWith(".docx");
  }
  return false;
}

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const buffer = Buffer.from(bytes);
  const { value } = await mammoth.extractRawText({ buffer });
  return value.trim();
}
