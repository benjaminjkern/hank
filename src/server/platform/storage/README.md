# `platform/storage/` — bytes in Postgres

The domain-blind half of what used to be `src/server/files/`. Nothing here knows what a
company, job, or opportunity is — it stores and serves bytes, and that's the whole reason
it qualifies for `platform/`.

| Path | Backing table | What it is |
| --- | --- | --- |
| `attachments.ts` | `Attachment` | Bytes-in-Postgres primitive — any file dropped into chat. Upload, fetch, link-to-message, list-for-messages. |
| `contentBlocks.ts` | — | Turns a stored attachment into an Anthropic content block (image / document / text). |
| `docx.ts` | — | docx detection + mammoth text extraction. Upload-time preprocessing for chat attachments *and* resume upload (docx is flattened to text; the original MIME is preserved). |
| `download.ts` | — | Builds an HTTP download `Response` for raw bytes (docx-as-text special-casing, filename sanitization). Used by the attachment and resume file-download routes. |

**The product-aware halves of file handling live elsewhere.** Two things that touch files know
too much about the product to sit in infra:

- The `Resume` row lives in **[`entities/resume/`](../../entities/resume/)** — a first-class
  profile object (many per user), read and merged into the `resume.md` memory note; the row
  itself carries only the file, and its store imports the resume-parsing sub-agent. It builds
  *on* `attachments.ts`; it is not just an attachment.
- The Documents read model lives in **[`views/documents.ts`](../../views/documents.ts)** — a view
  with no table of its own, aggregating memory notes, the `Resume` row, `JobInteraction` draft
  artifacts, and `Attachment` rows into one `UserDocuments` shape for the Documents page.
