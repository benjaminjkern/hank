# UI conventions

Three things must agree across views — chat message shape, status pill colors, and theming — and each has a single source of truth. Don't roll a bespoke version in a new view; reach for the helper.

## Right panel modes

Six entity-scoped modes — `dashboard`, `company-context`, `job-detail`, `opportunity-detail`, `shortlist-board`, `application` (plus the non-entity `documents` / `analytics`) — routed in [RightPanel.tsx](../src/components/RightPanel/RightPanel.tsx) by `panelMode` + `viewed*` state in [chatStore.ts](../src/lib/chatStore.ts). Each render path falls back to the empty hint when its viewed-entity state is missing. Adding a mode: extend the `PanelMode` union + either the precedence in [showEvents.ts](../src/server/views/showEvents.ts) `buildShowEvents` (job > opportunity > company > dashboard, derived from the **loaded views**) or — when the mode isn't derivable from which entity loaded — a **sibling builder** the way `buildShortlistBoardEvents` / `buildApplicationEvents` do it. (`/api/session` cold-load has no focus to restore — it opens on `dashboard` — so there's no precedence to mirror there anymore.)

**Shortlist board** ([ShortlistBoardView.tsx](../src/components/RightPanel/ShortlistBoardView.tsx), design [shortlist-board.md](flows.md)) — the per-company negotiation screen: every role STILL being considered, grouped (picks / borderline / pass / undecided, plus collapsed not-read-yet and on-hold tails), each row with the deciding pass's reason. Decided roles — closed, delisted, applied — aren't here; the company page's never-pursued list holds those. So EVERY row carries the same three marks (Pick / Maybe / Pass) pre-selected to Hank's proposal — clicking the selected one clears it to undecided — and they POST to the board edit route. Edits persist immediately but the row stays in its current group, accent-bordered, until the next message relays and settles it (the composer shows a pending-changes chip, the sent bubble shows per-row chips). Reached from the seed's show events, the company page's "Shortlist board" link, and `show_shortlist_board`; breadcrumb `Dashboard / <Company> / Shortlist`, tab label "Shortlist".

**Application page** ([ApplicationView.tsx](../src/components/RightPanel/ApplicationView.tsx), design [application-page.md](application-page.md)) — one job's application as a shared document: every item the form asks for, in form order, each a full-width editor with room to actually write (the cover letter gets a tall one). Items with nothing written are still listed — a question Hank passed over is one the user can still answer — carrying his one-line reason and a placeholder instead of text. Editing persists on blur through `PATCH /api/jobs/[id]/application` and never wakes Hank; the item takes an accent border and an "edited · not sent yet" tag until the next message relays it. Header carries Send-my-changes / Looks-good (adaptive, same as the board), **I submitted ✓** (posts the same `confirm_application_submit` widget message the chat widget does), and a link to the posting. Reached from the job page's Application card, the Documents artifacts list, `show_application`, and automatically when drafting produces something; breadcrumb `Dashboard / <Company> / <Role> / Application`, tab label "Application".

## Responsive layout (narrow viewport)

Below `theme.breakpoints.narrow` (900px) the 50/50 grid ([SplitLayout.tsx](../src/components/Layout/SplitLayout.tsx)) collapses to one column + a two-tab switcher ([PanelTabs.tsx](../src/components/Layout/PanelTabs.tsx)). **Read the breakpoint from `theme.breakpoints.narrow`** — never hardcode `900px`. Two chat-store fields drive it: `activePanel: "chat" | "right"` (which pane shows on narrow; starts on `chat` since cold-load has no focus and opens on the dashboard) and `panelBadge: boolean` (accent dot signaling unseen agent changes — set when a `show`/`panel_mode` event lands mid-turn while the user is on the chat tab).

Badge rules ([chatStore.ts](../src/lib/chatStore.ts) `applyEvent`): mid-turn `focus`/`panel_mode` events set the badge only while `activePanel === "chat"`; the `done` event auto-flips to `right` if the badge is set and clears it; landing on the right tab (tap/swipe/auto-flip) clears it. New viewed-entity events hook the same `s.activePanel === "chat" ? true : s.panelBadge` pattern.

**Both panes stay mounted at all widths** — narrow-mode hiding is `display: none` via `$hideOnNarrow`, not conditional rendering, so chat scroll + textarea drafts survive tab switches. A wide-only render branch (collapse drawers, resizers) needs a narrow short-circuit too — gate on `useIsNarrow`, not just `@media` visibility. Mount-time scroll/measurement effects must account for `scrollHeight === 0` inside a hidden pane (ChatPanel re-pins on `[activePanel]`).

## Layout height chain

Home-page panes use a percentage-height chain rooted at `100dvh`; every container between it and a `1fr` child needs an explicit `height`. **Never substitute `calc(100dvh - <fixed rows>)`** — it desyncs from `grid-template-rows` the moment a row is added. Rationale lives in [SplitLayout.tsx](../src/components/Layout/SplitLayout.tsx) comments.

## Chat message shape

Assistant turns interleave text and tool calls. `MessageView.segments` is the load-bearing shape: an ordered `{kind:"text",text}` / `{kind:"tool",id,name,input,status,result?,progressLabel?}` array. Both `/api/session/route.ts` (persisted) and streaming `applyEvent` preserve order so narration renders above/below its chip. Assistant text renders through `react-markdown` + `remark-gfm`; user text renders verbatim. Chip `status` is `"pending" | "done" | "error"` (see [tools.md → Tool errors](tools.md#tool-errors)). A finished assistant turn with no visible segments paints no bubble.

**A failed run is its own segment.** When a run throws, [`runUserMessage`](../src/server/agent/runtime/runUserMessage.ts) writes a `run_error` block before re-throwing, and the client pushes a matching `{kind:"error",detail}` segment off the SSE `error` event. Both are needed: the SSE event paints it instantly, the block is what survives the reconcile the following `done` triggers — an error that lives only in client memory flashes and then vanishes. It renders as [`ExpandableError`](../src/components/Chat/ChatPanel.tsx), same chrome as the tool chip: a collapsed danger-toned row ("Something went wrong — this step didn't finish") that opens to the raw message, because the detail is operator text (a Prisma code, an HTTP status) and shouldn't read as Hank's prose. Key/credit failures are excluded — [`ApiKeyBlockerModal`](../src/components/ApiKeyBlockerModal.tsx) is their fix path, so a chat row would double up.

`ToolSegment.children?: Segment[]` is recursive — sub-agent activity nests under its parent chip, rendered by the same `SegmentView`. Populated live (`LoopEvent`s with `parentToolUseId`) and on reload (`ChatMessage.traces` JSONB via `convertTrace`). The chip is [`ExpandableToolChip`](../src/components/Chat/ChatPanel.tsx): collapsed by default, expand shows input/result/children. `upsertToolSegment` by `id` matters — `tool_use_start` fires twice (empty then real input). New chip variants branch in the chip header, not `SegmentView`.

**Inline reference tokens** live inside a text block (Anthropic blocks are text-only), split into clickable chips at render. Two kinds:

- **`<job-ref jobId label/>`** — generated by JobDetailView's "I submitted" button, parsed via [`splitJobRefTokens`](../src/lib/jobRefToken.ts) in the message text branch.
- **`<focus-ref refKind id label/>`** — the **focus-change chip** ("Picking up **Stripe**"), emitted **server-side** at every focus-change seam (the `show_*` tools + the deterministic picker/switch/revive/job-focus seams), never typed by Hank. It rides inside a `pipeline_status` block (reusing that channel's persist/stream/strip-for-the-LLM provenance) and splits at render inside the `StatusLine` via [`splitFocusRefTokens`](../src/lib/focusRefToken.ts). Click navigates by `refKind` (`viewCompany`/`viewJob`/`viewOpportunity`).

Both labels are captured at emit time (stay readable after rename/delete); both clicks are **view-only, never focus-changing** (focus is ephemeral — there's nothing to change). Add a new kind by mirroring the token lib (encoder + parser) + rendering it in the relevant `SegmentView` branch.

### Widget response cards

Every pipeline widget submission becomes a user `ChatMessage` whose text is `<!--widget-response:{kind,…}-->\n[label]` (built by [`buildWidgetSubmissionMessage`](../src/components/Chat/widgets/types.ts)). The marker is **not** stripped server-side — parsers read it as the user's choice; the agent sees the label as context. At render, [`WidgetResponseCard`](../src/components/Chat/widgets/WidgetResponseCard.tsx) (via `tryParseWidgetResponse` in `MessageBubble`) draws a bespoke card per `kind`; the raw marker never renders. Display data rides in an optional `_view` blob in the marker (submission carries IDs, not names/logos); keep it minimal (it's persisted + replayed). Missing `_view` degrades to a clean label chip. Server parsers pick known fields and ignore `_view` — don't switch one to strict zod without excluding it.

**Adding a widget?** Register in [widgetKinds.ts](../src/lib/widgetKinds.ts), add payload/submission types to [types.ts](../src/components/Chat/widgets/types.ts), the component + `KNOWN_WIDGET_KINDS` entry + dispatch case in [widgets/index.tsx](../src/components/Chat/widgets/index.tsx), a `renderWidgetText` case, the parser branch in the owning pipeline's `widgetSubmission.ts`, and a `WidgetResponseCard` branch. The interactive widget mounts in the sticky slot (below), not `MessageBubble`.

## Status pill colors

Use [`statusColor(theme, status)`](../src/lib/statusColors.ts) for any pill and [`statusTone(status)`](../src/lib/statusColors.ts) to categorize. The authoritative per-status table lives in **[docs/lifecycle.md](lifecycle.md)** — read it first when adding or moving a status; this section only covers UI. Seven tones:

| Tone         | Color        | When                                                                                                            |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `focusNow`   | brand purple | Mid-flight work the user drives — PITCHED, SCANNED, SHORTLISTED, APPLYING, IN_PROCESS, OPEN, INTERVIEW_DEBRIEF, OFFERED. Carries the brand color. |
| `notStarted` | dark grey    | Surfaced, not triaged — NEW, READY.                                                                            |
| `resting`    | green        | Ball's in their court / scheduled — APPLIED, IN_FLIGHT, RESPONDED, INTERVIEW_SCHEDULED, AWAITING.              |
| `watching`   | teal         | On the watchlist, nothing actionable — CAUGHT_UP.                                                              |
| `deferred`   | amber        | Set aside, held indefinitely (no revisit timer) — company PAUSED, job DEFERRED.                                |
| `blocked`    | slate        | Technical set-aside, board couldn't be read (revivable) — BLOCKED.                                             |
| `closed`     | red          | Terminal for the round — CLOSED, REJECTED, DELISTED.                            |

`statusLabel()` (same file) maps enum names that shouldn't render verbatim (e.g. `PAUSED`→"Paused", `BLOCKED`→"Couldn't load roles", `DELISTED`→"No longer listed"); everything else Title-cases. Legacy `SCREENING`/`ONSITE` map to `resting`. `statusTone` is the single decision point — extend it **and** [docs/lifecycle.md](lifecycle.md) in the same commit when adding a status. Its sibling `companyEventLabel()` (same file) does the same for the `CompanyEventType` timeline (`JOBS_CLOSED`→"Roles closed", `SHORTLIST_RAN`→"Shortlist", …) — add an entry when you add a company-event type, or the raw multi-word enum renders.

## Focused state visual treatment (now inert)

The dashboard / company-page rows still carry a `bgFocused` accent-tint code path (glowing the group whose child matched `focus.jobId`), but it's **inert** — focus is ephemeral, so `chatStore.focus` is always null and nothing glows. The clickable `focus_ref` chips in chat are the "where did focus go" signal now. `bgFocused` remains a theme token in [theme.ts](../src/lib/theme.ts); removing the dead tint logic from DashboardView / CompanyContextView is follow-up polish.

## Dashboard buckets

Eight collapsible buckets, each with a tone-colored dot before the title: **Now / In process / Not started / In flight / Watching / Paused / Blocked / Closed** (union keys `now`/`inProcess`/`next`/`awaitingReply`/`watching`/`paused`/`blocked`/`closed`). Authoritative bucket→tone→membership table in [docs/lifecycle.md](lifecycle.md#dashboard-buckets); logic in [DashboardView.tsx](../src/components/RightPanel/DashboardView.tsx) (`bucketForCompany`/`bucketForOpportunity`/`userOwes`). Paused/blocked/closed come pre-split from the server (`data.paused`/`data.blocked`/`data.closed`).

- **Now + In process open by default; the rest collapsed.** `Now` always renders (even empty); others hide their header when empty (Closed renders only when non-empty).
- **`userOwes(status)` is `statusTone(status) === "focusNow"`** — any focusNow JobInteraction bumps its company to Now regardless of company status. Route through `statusTone`, don't hand-list.
- Tone color appears in the `BucketDot` and the header's `:hover` tint (`color-mix`). Don't reintroduce a full-bleed stripe or per-bucket resting backgrounds.

Adding a bucket: extend the `Bucket` union, `BUCKET_TONE`, `BUCKET_META`, `DEFAULT_OPEN`, the `bucketForCompany`/`bucketForOpportunity` decision, the iteration array, and the [docs/lifecycle.md](lifecycle.md) table.

## Company + opportunity pages

[CompanyContextView](../src/components/RightPanel/CompanyContextView.tsx) renders `company.description`, a reason banner for set-aside companies (red close chip for CLOSED with `closeReason`; amber tone-aware `ReasonChip` for BLOCKED with `blockReason` and PAUSED with `pauseReason`), then three job groups: **In pipeline** (`focusNow`+`resting`), **New** (`NEW` only, drained before CAUGHT_UP), **Skipped** (`closed`, behind a toggle). [OpportunityDetailView](../src/components/RightPanel/OpportunityDetailView.tsx) mirrors this: live roles inline, CLOSED/REJECTED behind a `Show skipped` toggle surfacing `closeReason`/`closeNote`. Dashboard opportunity `jobs[]` is server-filtered to live roles. Opportunity-linked jobs show a `← Pitched via <lead>` chip on JobDetailView (`viewOpportunity`); APPLIED rows with `applyChannel` RECRUITER/REFERRAL show a `via recruiter`/`via referral` caption.

The company page's **"Recent activity"** card (`RecentActivityList`) reads the first-class [`CompanyEvent`](../src/server/entities/companies/logCompanyEvent.ts) timeline — batch summaries ("Closed 45 roles: not a match"), per-role milestones (with the job title as `context`), and status changes — **not** a flatten of every job's `JobEvent`s (the old behavior that let one batch close render as 400+ rows). Types run through `companyEventLabel()` before display. JobDetailView's own timeline still reads that role's `JobEvent`s.

## Shared right-panel primitives — reach first, extract second

Most right-panel inconsistencies came from the same concept re-implemented per surface and drifting. Two standing rules in [src/components/RightPanel/](../src/components/RightPanel/):

1. **Reach for the existing primitive before writing markup**: `statusColor`/`statusTone` ([statusColors.ts](../src/lib/statusColors.ts)), `companyLogoUrl` + the logo-chip template (`<img>` + `onError`→`initial`), `relativeTime` ([date.ts](../src/utils/date.ts)), and the [shared/](../src/components/RightPanel/shared/) pieces — [`RecentActivity`/`RecentActivityList`](../src/components/RightPanel/shared/RecentActivity.tsx) (timelines; headless-inner + chrome-wrapper split so a surface can BYO chrome) and [`useExpandable(items, previewCount)`](../src/components/RightPanel/shared/useExpandable.ts) (preview/expand bookkeeping — returns `{visible, expanded, truncated, canCollapse, hiddenCount, expand, collapse, toggle}`; pass `items.length` to opt out of capping).
2. **When you'd copy-paste stateful UI a second/third time, extract** into [shared/](../src/components/RightPanel/shared/) (a hook for logic, a headless-inner + chrome-wrapper for differing chrome) and add a short section here. A one-place primitive can't drift.

## Documents view + the shared artifact editor

[DocumentsView](../src/components/RightPanel/DocumentsView.tsx) is a non-entity-scoped mode (`panelMode === "documents"`, like `dashboard`) reached from the **Documents** button in [TopBar](../src/components/Layout/TopBar.tsx). User-navigable only; Hank never focuses it. It fetches `/api/documents` on mount and is a tiny router: an **index of cards** → per-document **sub-pages**. Card order: **Resume · Profile · Frequent questions · Cover letters & short answers · Uploaded files**. Router state (`subPage` / `expandedArtifacts` / `scrollTop` / `returnFromJob`) lives in `chatStore.documentsNav` so it survives DocumentsView unmounting when a job opens.

**Storage → user-facing name inventory** (all impersonation-safe via `resolveViewedUser`; writes gated by `rejectImpersonatedWrite`):

| Storage | User-facing | Editable |
| --- | --- | --- |
| `profile.md` (MemoryNote) | **Profile** (thesis + constraints + voice) | inline markdown, edit-in-place |
| `frequent_questions.md` | **Frequent questions** | inline markdown (`## question` + answer) |
| `resume.md` (MemoryNote) | **Resume** — the user's background | inline markdown, edit-in-place |
| `Resume.fileBytes`/`fileName` | resume **files** (many) | download each + upload another |
| `JobInteraction.coverLetter` | **Cover letters** | editor on job page |
| `JobInteraction.shortAnswers[]` | **Short answers** | editor on job page |
| `Attachment.fileBytes` | **Uploaded files** | download only |

Narrative docs edit in place via `InlineEditableDoc` (always-live textarea, autosave on blur). Memory writes go through `PUT /api/documents/memory` `{doc, content}` where `doc` is a **kind** (`profile`/`frequent_questions`/`resume`), mapped to a path by `saveUserDoc` — arbitrary paths unreachable.

**The Resume sub-page is one editable note plus a file list.** `resume.md` holds the user's whole background in full detail; each upload is parsed and *merged* into it (see [memory.md](memory.md)), so the page offers **Add another** rather than Replace, and every uploaded file stays downloadable at `/api/documents/resume/file?id=…`. There is no separate summary panel and no separate framing-notes box — framing lives in **Profile**.

**Cover letters & short answers are read-only here** — one collapsible `JobArtifactBlock` per job (chevron + title + company + "Cover letter · N answers" + status pill; expand → **Open application to edit →** + `Prose` bodies + per-artifact reuse switch + `ConfirmRemoveButton`). The **editors live on the application page only** ([ApplicationView.tsx](../src/components/RightPanel/ApplicationView.tsx)) — this page is for browsing across jobs, that one is for writing; don't re-roll a second editor. Documents reuses [shared/applicationArtifacts.tsx](../src/components/RightPanel/shared/applicationArtifacts.tsx)'s `ReuseSwitch`/`ConfirmRemoveButton`/`patchJobInteraction`/`buildShortAnswersReuse`.

**Reuse toggle (load-bearing — flows.md and memory.md point here).** `ReuseSwitch` ("Include in profile") controls whether an artifact feeds [`loadPastDrafts`](../src/server/entities/jobs/pastDrafts.ts) (→ `applicationDraftingSubAgent` + `applicationDeciderSubAgent`). `JobInteraction.coverLetterReuse` (`Boolean?`) and `shortAnswersReuse` (`Json?` parallel array) are a **plain boolean — only `true` includes**; `false` and `null` both exclude (`effectiveReuse(reuse) = reuse === true`), and every Hank write sets `false` explicitly, so nothing the agent drafts feeds itself until the user opts it in. It is the ONLY state an artifact carries beyond its text — there is no separate usage timestamp, and nothing is ever deleted on APPLIED. Editing a draft or pressing Copy on the job page auto-flips the switch on (still toggleable), which is why it also reads as "the user has claimed this text". The switch is hidden in impersonation read-only mode.

**Back to Documents.** Opening an application via **Open application to edit →** (`openApplicationFromDocuments`) arms `documentsNav.returnFromJob`; ApplicationView then renders a `← Documents` back link restoring sub-page / expanded blocks / scroll (container tagged `data-rp-scroll`) and refetching drafts. `viewJob` clears the flag on every other entry.

## Company logos

Three surfaces render a logo chip (CompanyContextView 48px, JobDetailView 18px, DashboardView 20px), all sharing `<img>` + `onError`→[`initial(name)`](../src/utils/text.ts). Loaders ship a pre-resolved `logoUrl` via [`companyLogoUrl(sourceUrl, override)`](../src/lib/companyLogo.ts) — never reach into the DB column. A fourth surface copies the chip template; only size varies.

## Hank brand mark

The logo lives in three independent copies that must stay in sync: [HankLogo.tsx](../src/components/HankLogo.tsx) (shared React component, used by TopBar + SignInPanel), [icon.svg](../src/app/icon.svg) (favicon), and `drawBlock` in [HankRain.tsx](../src/app/signin/HankRain.tsx) (canvas physics blocks). Touch all three when tweaking the design. The drop-shadow (lit-from-above) is applied at the React + SVG sites, theme-aware; HankRain omits it deliberately.

## Chat panel scroll + render invariants

Three load-bearing, silent-to-break things in [ChatPanel.tsx](../src/components/Chat/ChatPanel.tsx): `MessageBubble` is `React.memo`'d (keep per-bubble props referentially stable or every keystroke re-parses markdown); auto-scroll is keyed on `[messages]` gated by `pinnedToBottomRef` (chatStore returns a new array ref per delta); a sibling effect re-pins on `[activePanel]` for the hidden-pane measurement case. Both effects share the pin ref.

## Welcome + loading

ChatPanel renders **empty** vs **non-empty** layouts off `messages.length === 0` — render conditionally (not `display:none`-toggle) with **stable React keys on every child** so the Composer instance is reused across the swap (else it remounts and loses draft + attachments). [`LoadingOverlay`](../src/components/LoadingOverlay.tsx) covers the viewport until `chatStore.hydrated` (rendered as a sibling of SplitLayout in [page.tsx](../src/app/page.tsx), `z-index: 2000`); it's the client-hydration cover that `app/loading.tsx` can't provide.

## Composer + sticky widget slot

The sticky widget **overlays** the bottom of the chat (it doesn't take a layout row). `ChatPanel` renders [`PipelineWidgetSlot`](../src/components/Chat/widgets/index.tsx) inside `WidgetOverlay` — `position: absolute`, pinned to the bottom of `MessagesArea`, `z-index: 2`, `pointer-events: none` with the card re-enabling. It doesn't steal scroll height: `MessagesScroll` reserves bottom padding equal to the overlay's `ResizeObserver`-measured height. Keep overlay + reserve-padding — don't move it to a layout row or portal.

**`WidgetShell`** ([WidgetShell.tsx](../src/components/Chat/widgets/WidgetShell.tsx)) is the single source of card chrome — pass `title`(+`headerExtra`), `children` (scrollable body), `footer` (actions). It owns the floating-card styling, sticky header/footer + scrolling body (`overscroll-behavior: contain`), a ~70%-of-chat-area height cap, and minimize (on by default; pass `minimizable={false}` to opt out). In-body primitives live in [sharedStyles.ts](../src/components/Chat/widgets/sharedStyles.ts); freeform inputs use [`AutoGrowTextarea`](../src/components/Chat/widgets/AutoGrowTextarea.tsx).

**Confirm-first pickers** (next-company / next-job) use [`suggestionPicker.tsx`](../src/components/Chat/widgets/suggestionPicker.tsx) (`useSuggestionPicker` + `SuggestionCard` + `LinkButton`): a `confirm ⇄ list` toggle where `defaultSuggestion` is the top **active** item only (pass `null` to open on the list — never auto-suggest a deferred row; confirming a deferred row uses revive wording and revives server-side). Row kinds: `company`, `opportunity`, `job`; adding one touches `rowDisplayName`/`Avatar`/`jobPrimaryLabel` + the `WidgetResponseCard` branch.

**Send + dismissal.** Send always fires a regular `send(text)` — it's never hijacked to commit a widget; each widget submits via its own action through the `<!--widget-response:…-->` marker. `PipelineWidgetSlot` scans history newest-first and **breaks at the first `user` message**, so typing anything dismisses the widget. Widget buttons pressed mid-stream **queue** via `chatStore.queuedSend` (not disabled).

## Stop button

While `streaming`, Send is replaced by a round `StopButton`; it never disables. `chatStore.stop()` is **single-press**: one press POSTs `/api/chat/stop`, which aborts the run server-side (tearing down the in-flight stream + tool call at once). The client keeps reading so the terminal `stopped`+`done` render the saved partial with no reconcile flash — it aborts its own SSE fetch only as a fallback if that POST fails. There's no soft/hard two-tier and no second-press escalation (the old `softStop` flag + 5s timer are gone). `StoppedPill` ("Response interrupted", muted — **not** a status pill) renders under any `MessageBubble` whose `message.stoppedByUser === true` (live via the `stopped` SSE event, on reload via the column). The flag covers any cut-off reply — a Stop press, a dropped connection, or a genuine mid-stream error — so the label is deliberately cause-neutral. A cut-off turn may leave `tool_use` blocks with no `tool_result` — see [tools.md → Replay + abort invariant](tools.md#replay--abort-invariant).

## Theming

- Both palettes share the same keys; consume via `${({ theme }) => theme.colors.X}` — never hardcode hex (brand-mark SVGs are the only exception). Accent-button text uses `theme.colors.onAccent`.
- Mode is `'light' | 'dark' | 'system'`, owned by the in-module store in [themeMode.ts](../src/lib/themeMode.ts) (`useThemeMode()`) — don't add a zustand store. The inline `<head>` script in [layout.tsx](../src/app/layout.tsx) writes `html[data-theme]` before paint and is the source of truth.
- No-flash depends on three pieces staying in sync: the inline script, the `html[data-theme="…"]` rules in [globals.css](../src/app/globals.css), and the SSR-dark default from `getServerSnapshot`.
- For dark-mode-specific CSS that doesn't fit the palette (filters, gradient stops, shadow strengths), branch inside the styled-component via `html[data-theme="dark"] &`.
