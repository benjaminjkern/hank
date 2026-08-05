import { DOCX_MIME } from "@/server/platform/storage/docx";

// Build an attachment download Response. .docx uploads (resume or chat files)
// are stored as mammoth-extracted UTF-8 text, not the original Word file — so
// serve those as text/plain with a .txt name rather than handing the user a
// corrupt .docx. Filename is sanitized against header-injection.
export function fileDownloadResponse(
  bytes: Uint8Array,
  fileName: string,
  fileMime: string,
): Response {
  const isDocxText = fileMime === DOCX_MIME;
  const contentType = isDocxText
    ? "text/plain; charset=utf-8"
    : fileMime || "application/octet-stream";
  const safeName = (
    isDocxText ? fileName.replace(/\.docx$/i, "") + ".txt" : fileName
  ).replace(/[\r\n"]/g, "_");
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}
