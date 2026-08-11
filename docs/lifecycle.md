# Statuses & lifecycle

Three parallel state machines: `JobInteraction.status` (a single role at a company), `CompanyInteraction.status` (the watchlist's intent toward a whole company), and `Opportunity.status` (inbound leads that don't yet map to a known Job). All three are driven by events; statuses are denormalized caches updated via `EVENT_TO_STATUS` in [jobEventStatus.ts](../src/server/entities/jobs/jobEventStatus.ts).

The first half of this doc is the **quick reference** (tone / meaning / who-acts-next per status, + dashboard buckets); the second half is the **mechanics** (transitions, gates, events).

> **All-caps enum names are Hank's internals**, never quoted to the user — translation is enforced by the "Translate, don't parrot" preamble in [hank/system.ts](../src/server/agent/hank/system.ts) and by sub-agent output-schema field constraints. When you add a status / reason / event, add the natural phrase there too. (Inline note fields — `closeNote` / `deferNote` / `pauseNote` — are one of three places context lives; see [memory.md](memory.md). There is no general-purpose `JobInteraction.notes`; per-job prose goes to `jobs/{slug}.md`.)

> **Naming overlap.** `SHORTLISTED` / `CLOSED` / `APPLIED` exist as both a status and an event: the event is a point-in-time record that _causes_ the status transition. (`SCANNED` is a status too, but no longer fires an event — see the event list below.)

## Tones

App-wide vocabulary for reading urgency at a glance — the seven-color category used by status pills and dashboard bucket stripes. Centralized in [`statusColors.ts`](../src/lib/statusColors.ts); update it and this doc together when adding a status.

| Tone         | Color                    | Meaning                                                                                       |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------------- |
| `focusNow`   | Hank purple (= `accent`) | Mid-flight work the user actively drives — focus on it right now.                              |
| `notStarted` | Dark grey                | Surfaced but not triaged yet. Background information, not competing for attention.             |
| `resting`    | Green                    | No work right now — the other side owes the next move.                                         |
| `watching`   | Teal                     | On the watchlist, nothing actionable — scanned, monitoring for new postings.                  |
| `deferred`   | Amber                    | Set aside for now (company `PAUSED` / job `DEFERRED`). Held indefinitely — no revisit timer.   |
| `blocked`    | Slate                    | Technical set-aside — the board couldn't be read. Not a fit pause.                             |
| `closed`     | Red                      | Closed, skipped, or rejected. Terminal for the round.                                          |

## JobInteraction status

Role-pursuit lifecycle. Source enum: `JobInteractionStatus` in [prisma/schema.prisma](../prisma/schema.prisma).

| Status                | Tone       | Meaning                                                                        | Who acts next                     |
| --------------------- | ---------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `PITCHED`             | focusNow   | Recruiter pitched this role via an Opportunity; no triage yet.                 | User (pursue or decline)          |
| `NEW`                 | notStarted | Surfaced by a scan; no decision yet. Default for fresh rows.                    | User (open it so Hank can scan)   |
| `SCANNED`             | focusNow   | Hank read the full description; the role is in the shortlist-board pool.       | User (settle the board)           |
| `SHORTLISTED`         | focusNow   | User approved the pick; queued to apply to, nothing written yet.               | User (start it)                   |
| `APPLYING`            | focusNow   | A drafting pass has started; the application is being written.                 | User (write + submit)             |
| `APPLIED`             | resting    | Application submitted; waiting on first response.                              | Company                           |
| `RESPONDED`           | resting    | They've replied at least once; conversation alive.                            | Company (soft followup tier)      |
| `INTERVIEW_SCHEDULED` | resting    | An interview is on the calendar (any round; name in the event note).          | Calendar                          |
| `INTERVIEW_DEBRIEF`   | focusNow   | The interview date has passed; Hank should ask how it went.                    | User (debrief Hank)               |
| `WAITING_ON_RESPONSE` | resting    | Debriefed; ball's in the company's court. Off-ramp so it stops nagging.        | Company (resurfaces after ~14d)   |
| `OFFERED`             | focusNow   | Offer in hand; user owes a decision.                                           | User (accept / negotiate / decline) |
| `DEFERRED`            | deferred   | Could apply, just outranked for now. `deferReason` records why.               | User/Hank (revive when ready)     |
| `CLOSED`              | closed     | Closed before applying, or post-application withdrawal. `closeReason` records why. | Nobody — terminal             |
| `REJECTED`            | closed     | Company-side rejection.                                                        | Nobody — terminal                 |
| `DELISTED`            | closed     | Posting was taken down; a board re-scrape no longer returns it. System-set.     | Nobody — terminal                 |
| `SCREENING`/`ONSITE`  | resting    | Legacy tombstones (pre-`INTERVIEW_*` collapse). Don't write.                   | —                                 |

Reason enums: `CLOSED` → `JobCloseReason` (`WITHDRAWN` / `NOT_A_MATCH` / `LOCATION_MISMATCH` / `USER_REJECTED` / `OTHER`). `DEFERRED` → `JobDeferReason` (`OUTRANKED` / `OTHER`).

## CompanyInteraction status

Watchlist intent toward a whole company. Source enum: `CompanyStatus`. `IN_FLIGHT` / `IN_PROCESS` are auto-derived from job state ([engagement.ts](../src/server/entities/companies/engagement.ts)); the rest are set explicitly.

| Status      | Tone       | Meaning                                                                                       | Who acts next                     |
| ----------- | ---------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| `NEW`       | notStarted | On the watchlist; not yet enriched/scanned.                                                    | User / Hank commits the enrich    |
| `READY`     | notStarted | Scanned, PRE_SCAN passed with survivors; walkthrough not started. Also where a company sits while its board is being read — nothing is owed by the user yet. | User / Hank starts the walkthrough |
| `SHORTLISTING` | focusNow | The board is seeded and open — the round is waiting on the user's marks.                       | User (mark the board)             |
| `APPLYING`  | focusNow   | Shortlist committed; working the roles that survived it — drafting, applying.                  | User (work the round)             |
| `IN_FLIGHT` | resting    | At least one application live (a job in APPLIED, no reply yet). Auto-derived.                  | Employer                          |
| `IN_PROCESS`| focusNow   | An employer has engaged (recruiter replied / interview scheduled). Auto-derived; outranks IN_FLIGHT. | User (prep / respond)      |
| `CAUGHT_UP` | watching   | Worked through everything posted; nothing live, nothing to do — or on-thesis with no current fit. Stays watchable. | Nobody — wait for fresh signal |
| `PAUSED`    | deferred   | Deliberately set aside for now. Required `pauseReason`. Excluded from scans until revived. | User/Hank (revive when ready) |
| `BLOCKED`   | blocked    | Technical set-aside — the board couldn't be read. Required `blockReason`. Not a fit judgment; revivable. | User/Hank (re-check the board) |
| `CLOSED`    | closed     | Genuine dead-end that won't work anytime soon. Required `closeReason`. Revivable.             | User (name it again to revive)    |

Reason enums (required when that status is set): `PAUSED` → `CompanyPauseReason` (`USER_PAUSED` / `OTHER`). `BLOCKED` → `CompanyBlockReason` (offered: `CANNOT_SCRAPE` / `NO_OWN_BOARD` / `OTHER`). `CLOSED` → `CompanyCloseReason` (offered: `NOT_A_MATCH` / `LOCATION_MISMATCH` / `OTHER`).

## Opportunity status

Lead-level state of an inbound conversation thread. Per-role state lives on the linked `JobInteraction.status`. Source enum: `OpportunityStatus`.

| Status      | Tone     | Meaning                                                              | Who acts next               |
| ----------- | -------- | ------------------------------------------------------------------- | --------------------------- |
| `OPEN`      | focusNow | Conversation alive; no call scheduled yet. Default for new leads.   | User (triage the pitch)     |
| `SCREENING` | resting  | A call/screen is on the calendar, or just happened.                | Calendar / them             |
| `AWAITING`  | resting  | Process started; the other side owes the next step.                | Them                        |
| `CLOSED`    | closed   | Conversation ended (ghosted, mutual pass, all linked jobs resolved). | Nobody — terminal         |
| `CONVERTED`/`INBOUND` | closed | Legacy tombstones; new code never writes.               | —                           |

## Dashboard buckets

The dashboard groups items by what the user should do next, not by raw status. Tones map 1:1 to bucket stripes. Selection is in [`DashboardView.tsx`](../src/components/RightPanel/DashboardView.tsx); Paused/Blocked/Closed are pre-split server-side in [`route.ts`](../src/app/api/dashboard/route.ts).

| Bucket          | Stripe tone | Default open? | Membership                                                                                   |
| --------------- | ----------- | ------------- | -------------------------------------------------------------------------------------------- |
| **Now**         | focusNow    | yes           | `SHORTLISTING` + `APPLYING` companies, companies with a focusNow job (`INTERVIEW_DEBRIEF` / `OFFERED`), focusNow Opportunities. |
| **In process**  | focusNow    | yes           | `IN_PROCESS` companies — a recruiter's engaged / an interview is scheduled.                   |
| **Not started** | notStarted  | no            | `NEW` / `READY` companies with no JobInteractions yet.                                           |
| **In flight**   | resting     | no            | `IN_FLIGHT` companies + opportunities awaiting their next move. Internal key `awaitingReply`. |
| **Watching**    | watching    | no            | `CAUGHT_UP` companies — scanned, monitoring for new postings.                                 |
| **Paused**      | deferred    | no            | `PAUSED` companies (server `data.paused`). Rows show the `pauseReason` chip.                  |
| **Blocked**     | blocked     | no            | `BLOCKED` companies (server `data.blocked`). Rows show the `blockReason` chip.                |
| **Closed**      | closed      | no            | `CLOSED` companies (server `data.closed`).                                                    |

Only **Now** + **In process** are open by default — the dashboard reads as "here's what you should be doing right now". Bucket membership uses `statusTone()` so it stays consistent with pill colors.

---

# Transitions, gates & events

## Job interaction

**Intended flow:** `NEW → SCANNED → (SHORTLISTED | CLOSED | DEFERRED) → APPLYING → APPLIED → RESPONDED → INTERVIEW_SCHEDULED → INTERVIEW_DEBRIEF → WAITING_ON_RESPONSE → OFFERED` for scan-flow jobs; `PITCHED → (SCANNED | CLOSED | DEFERRED) → SHORTLISTED → APPLYING → APPLIED → …` for opportunity-linked roles.

Transition mechanics:

- `SCANNED` is **auto-set** by `read_job_description` when a row is `NEW` or `PITCHED`; never set directly. It deliberately does NOT promote `CLOSED → SCANNED` (would overwrite `closeReason`/`closeNote`) — undo a close via `update_job_interaction({job, status:'NEW'|'SHORTLISTED'})`, which clears the close fields as it goes.
- `SHORTLISTED` lands via `commit_shortlist` applying the board's PICK stances ([commitShortlist.ts](../src/server/entities/companies/commitShortlist.ts)). Stances (`proposedVerdict/Reason/By/At` on `JobInteraction`) are pre-commit negotiation state — no status changes until the commit, and every status write clears them (stance clear-on-transition in `logJobEvents`). No round-completeness gate.
- `APPLYING` is set by [`runDraftApplication`](../src/server/procedures/registry/draftApplication/index.ts) when a pass starts on a `SHORTLISTED` row — so both entries (the walkthrough job arm and the `draft_application` tool) get it, and neither `work_on_job` nor the picker has to. It writes **no `JobEvent`**, matching `promoteJobForWork`: a workflow promotion is not a thing that happened to the application. It is otherwise identical to `SHORTLISTED` — every "is this role live work" read goes through `WORKABLE_STATUSES` ([jobInteractionInputs.ts](../src/server/entities/jobs/jobInteractionInputs.ts)), which holds both, so a query that widened to one widened to the other. Deliberately NOT in the shortlist pool or `CONSIDERED_STATUSES`: a role someone has started writing shouldn't be yanked back onto the board by a re-seed.
- `DEFERRED` — the board commit stamps `OUTRANKED` + `deferNote ← proposedReason` on BORDERLINE rows; a `direction` re-seed pulls them back into the ranking without touching status. Transitioning out clears `deferReason`/`deferNote`. Picking a DEFERRED job from the walkthrough's `next_job_picker` revives it → `SHORTLISTED` in the same transaction that sets focus.
- `APPLIED` is its own write path via `mark_job_applied` (stamps `applyChannel` `DIRECT`/`RECRUITER`/`REFERRAL`); everything else lands via `log_job_events`, which refuses `type: APPLIED` so there's no second write path. Edit a logged event with `edit_job_event({eventId, occurredAt?, notes?})`; remove one with `delete_job_event({eventId})` — both target the event by its id (from `list_job_events`), so a repeated same-type event is addressable (surgical single-event; `untrack_job` removes the whole JobInteraction).
- `INTERVIEW_SCHEDULED → INTERVIEW_DEBRIEF` is a **lazy read-path promotion**: [`flipDueInterviewsToDebrief()`](../src/server/entities/jobs/flipDueInterviews.ts) runs a single SQL UPDATE flipping every scheduled row whose latest interview event is past-due, called by the dashboard / focused-view reads and at the top of every [`runUserMessage`](../src/server/agent/runtime/runUserMessage.ts) turn. No cron; writes-from-a-read is accepted in v0. Once flipped, the debrief surfaces as an Immediate job row in `next_company_picker` regardless of the parent company's status — see [flows.md → What's next](flows.md#whats-next--the-between-things-picker). (This is why event times must carry a real time-of-day: an interview logged at midnight reads as past-due all day. Event times are parsed in the user's browser timezone — see [`localTime.ts`](../src/server/platform/time/localTime.ts).)
- `INTERVIEW_DEBRIEF → WAITING_ON_RESPONSE` is **agent-driven**: after the user debriefs and there's no next round / offer / rejection, Hank logs an `AWAITING_RESPONSE` event. `WAITING_ON_RESPONSE` is `resting` and deliberately **not** in [`OWED_JOB_STATUSES`](../src/server/entities/jobs/attention.ts), so it drops out of "what's next" instead of nagging. It resurfaces once, as a gentle "want to follow up?" row, after `STALE_WAITING_DAYS` (14) of no new event — see the stale-waiting tier in [`whatsNextOptions.ts`](../src/server/views/whatsNextOptions.ts). A logged follow-up note resets the clock.
- `DELISTED` is **system-set** by the closure detection in [upsertScrapedJobs.ts](../src/server/entities/jobs/upsertScrapedJobs.ts) (a re-scrape no longer returns the posting): stamps global `Job.closedAt`, flips only the non-terminal set (NEW/SCANNED/SHORTLISTED/DEFERRED) **for every user watching the job** and logs a `DELISTED` job event per flipped row (`occurredAt = closedAt`), leaves applied/interviewing history intact, and collapses the batch into one `JOBS_CLOSED` company event. Terminal; excluded from the gates and `whats_next` (`list_jobs` lists every status now — no default filter). Three guards, because there is no un-delist path: it skips entirely when the scrape reported `truncatedAt` (a partial board's unfetched roles would read as taken down — see [ats-scrapers.md](ats-scrapers.md)), on an empty scrape, and when >34% of a non-trivial board goes missing at once (a scraper regression is likelier than a mass takedown, and a false skip self-corrects next scrape while a false close doesn't). This is the one deliberate bypass of the `logJobEvents` seam — that seam is per-user by construction and this write spans users; the file says so at the call site.
- `REJECTED` = company-side; the `WITHDRAWN` event maps to `CLOSED` + `closeReason=WITHDRAWN` (WITHDRAWN is not a status).

**Deferred jobs / paused companies never auto-resurface.** There's no revisit timer — the `deferredUntil` columns linger unused. A DEFERRED job / PAUSED company stays put until explicitly moved (picking it from the picker revives it). Contrast the interview-debrief flip, which _does_ auto-fire on read because "ask how it went" is unambiguous.

**Job events** (`JobEventType`): `SURFACED` (once, on first `JobInteraction(NEW)` for a (user, job) pair) · `SHORTLISTED` / `CLOSED` / `DEFERRED` (defer-the-rest + `defer_job`) / `APPLIED` / `RESPONDED` / `INTERVIEW_SCHEDULED` / `INTERVIEW_HAPPENED` / `AWAITING_RESPONSE` (debriefed, waiting on the company → `WAITING_ON_RESPONSE`) / `OFFERED` / `REJECTED` / `WITHDRAWN` / `DELISTED` (posting taken down) / `NOTE` (freeform). Informational events (`SURFACED` / `NOTE`) don't change status. **No longer emitted (enum tombstones, historical rows only):** `SCANNED` (the status→SCANNED flip stays; the event dominated the per-job timeline) and `DRAFT_USED` (a draft artifact's only state is now its `*Reuse` flag — see [flows.md](flows.md#dual-write--the-reuse-flag)). Legacy `SCREEN_*` / `ONSITE_*` stay as tombstones remapped to `INTERVIEW_*`; don't emit. Read a role's timeline via [`list_job_events`](../src/server/agent/tools/registry/listJobEvents.ts).

**Company events** (`CompanyEventType`) — a first-class per-(user, company) timeline that backs the company-page "Recent activity" card (NOT a flatten of job events). Written only via [`logCompanyEvent`](../src/server/entities/companies/logCompanyEvent.ts). Three kinds: **collapsed batch summaries** — `SCRAPE_FOUND` ("Found N new roles"), `JOBS_CLOSED` (one per reason bucket: "Closed 45 roles: not a match"), `SHORTLIST_RAN` ("Shortlisted 5, deferred 12") — so a batch that fans out N job events shows as ONE company row; **per-role milestones** dual-written with the JobEvent (`APPLIED` / `RESPONDED` / `INTERVIEW_SCHEDULED` / `INTERVIEW_HAPPENED` / `OFFERED` / `REJECTED` / `WITHDRAWN`, carrying `jobId`+`jobTitle`); and **company status changes** (`PAUSED` / `BLOCKED` / `CLOSED` / `CAUGHT_UP` / `REVIVED`). Labels via `companyEventLabel()` in [statusColors.ts](../src/lib/statusColors.ts). Agent-writable + editable: `log_company_events` logs any type, `list_company_events` reads the feed (each row carries the event id), and `edit_company_event` / `delete_company_event` target a row by that id. (There is no longer a parallel markdown `## Status history` note — the CompanyEvent feed is the sole status-transition record, read into the agent's focused-company context.)

### Three-tier "make it go away" ladder

The agent reaches for the softest tool that fits and **never deletes `Job` / `Company` rows itself** — the last tier is a flag the admin reviews out-of-band.

| Tier                         | Job tool                                                     | Company tool                                                    | Effect / resurfaces on rescan?                                                                                     |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Pause / defer (revisit later)| [`defer_job({job, reason})`](../src/server/agent/tools/registry/deferJob.ts) | [`pause_company({company, reason})`](../src/server/agent/tools/registry/pauseCompany.ts) | Status + reason kept, no timer. Job stays scannable; PAUSED company excluded from scans until revived.     |
| Soft skip                    | [`close_job({job, reason})`](../src/server/agent/tools/registry/closeJob.ts) | [`close_company({company, reason})`](../src/server/agent/tools/registry/closeCompany.ts) | Nothing deleted. CLOSED `JobInteraction` doesn't resurface; CLOSED company excluded from scans.            |
| User-scoped untrack          | [`untrack_job`](../src/server/agent/tools/registry/untrackJob.ts)  | [`untrack_company`](../src/server/agent/tools/registry/untrackCompany.ts) | Hard-deletes only this user's tracking (+ its events): `untrack_job` drops one JobInteraction; `untrack_company` drops the watchlist entry **and** every role JobInteraction at that company. Globals stay, so the next scan / re-add creates a fresh `NEW` (dedupe key `(userId, jobId)`). |
| Recommend for admin delete   | [`recommend_job_for_deletion`](../src/server/agent/tools/registry/recommendJobForDeletion.ts) | [`recommend_company_for_deletion`](../src/server/agent/tools/registry/recommendCompanyForDeletion.ts) | Sets `deletionRecommendedAt` + reason; row renders normally until the admin approves/dismisses at [`/admin/deletions`](../src/app/admin/deletions/). |

The required `reason` persists on the column and shows in the chat chip; re-calling keeps the original timestamp and overwrites the reason. Tier 3 is always **flag, never delete** in v0 — mirror this model for any new "make X go away" tool.

## Company interaction

**Intended flow:** `NEW → READY → SHORTLISTING → APPLYING → {IN_FLIGHT | IN_PROCESS | CAUGHT_UP}`, with `PAUSED` / `BLOCKED` / `CLOSED` as set-asides off any state.

Transition mechanics:

- `create_companies` / `createCompanyStubs` create at `NEW`, and **adding a company leaves it there** — enrichment ([`enrichCompanies/`](../src/server/procedures/registry/enrichCompanies/)) works out the company's identity (careers URL, name, description, logo) and writes no status, because it never scrapes. `NEW` is a first-class resting state: `loadBacklog` lists `READY` then `NEW`, so the what's-next picker surfaces it. The status moves the first time roles are actually pulled — the walkthrough, or `scrape_jobs_for_company` → PRE_SCAN → [`markCompanyPostFilter`](../src/server/entities/companies/markCompanyStatus.ts): `READY` (survivors remain) or `CAUGHT_UP` (nothing survived the metadata filter). PRE_SCAN itself writes no status and can't reach `CLOSED` — no automatic pass closes a company at all (see below). A **cold-start bail** (empty `profile.md`) writes nothing, leaving it `NEW` so `whats_next` rung 0 prompts for a thesis. Both flips guard via a status whitelist so a rescan doesn't demote a mid-walkthrough company. `Company.huntingStartedAt` is a transient "Scanning…" signal covering the whole enrich chain (stale >2min = crashed enrich).
- `SHORTLISTING` / `APPLYING` split the stretch between entering a company and finishing with it, and they answer different questions about whose move it is. **SHORTLISTING** is written wherever the board goes on screen with rows on it ([`markCompanyShortlisting`](../src/server/entities/companies/markCompanyStatus.ts), from both the fresh seed and the re-show): this is the one stretch where the next move is genuinely the user's, which is what earns it a status. **APPLYING** means the shortlist is committed and the survivors are being worked — set by `commitShortlist`, manually held, job events don't auto-move it. Both are "ongoing work" to `whats_next` rung 1.
- **There is no status for "mid-scan".** A company reads `READY` from the moment it's walkable until its board opens. A transient one existed and was dropped: it was written when a company was PICKED rather than when the scan began, and the walkthrough's own `markCompanyReady` overwrote it before any scanning started — so it described a state the company was never in. Entering a company writes `READY` and the walkthrough owns every status after it. What a wedged scan costs is therefore visibility, not correctness: re-entering re-derives, and the metadata pass no longer re-judges roles it already kept (`JobInteraction.preScannedAt`).
- `IN_FLIGHT` / `IN_PROCESS` / `CAUGHT_UP` are the **auto-derived engagement tail**: [`deriveCompanyEngagement`](../src/server/entities/companies/engagement.ts) recomputes from jobs (IN_PROCESS if any live job is RESPONDED/INTERVIEW_*/WAITING_ON_RESPONSE/OFFERED; else IN_FLIGHT if any APPLIED; else CAUGHT_UP). `refreshCompanyEngagement` (from `log_job_events` / `mark_job_applied`) only moves a company already in `{IN_FLIGHT, IN_PROCESS, CAUGHT_UP}`; manually-held statuses re-enter the tail only via a walkthrough wrap or revive.
- **A walkthrough wrap never CLOSES a company.** Every dead-end converges on CAUGHT_UP. A metadata cull (every role eliminated before any body was read, `liveCount===0`) auto-wraps CAUGHT_UP. An all-pass board, once committed, closes each ROLE (`NOT_A_MATCH`) but writes no company status — which empties the pool, so the next pass reaches that same cull branch and lands CAUGHT_UP. A snapshot of today's openings is a verdict on those roles, never on the company. CLOSED is reached only through a deliberate user/agent lever (`close_company`). `caught_up_company` (the "mark as caught up" lever) sets CAUGHT_UP directly but confirms first when open SHORTLISTED/SCANNED roles exist (re-call with `confirmed:true`).
- **Revives.** `reviveCompany` clears the set-aside and re-hunts the board (empty-prep enters whenever there's no `sourceUrl`, so a no-URL BLOCKED company actually re-looks). `company_walkthrough` on a CLOSED/BLOCKED company surfaces `confirm_revive_company` — the only re-check path (one company at a time). A revive re-scrapes for _new_ roles and does NOT un-close the closed backlog.
- **Re-running a flip on an already-terminal company is a pure correction, not a revive** — `close_company` / `pause_company` / `block_company` / `caught_up_company` on an already-CLOSED/PAUSED/BLOCKED company just updates status + reason (clear-on-transition still nulls the other statuses' fields); it does NOT reactivate or re-scan. [`update_company_interaction`](../src/server/agent/tools/registry/updateCompanyInteraction.ts) is the pure-correction path for the same row (status + reason/note, no `CompanyEvent`, no role cascade) — the company twin of `update_job_interaction`; being non-handoff, it's also how several companies get fixed in one turn (there's no bulk status tool).
- Scanning filters to `status NOT IN (CLOSED, PAUSED, BLOCKED)` — NEW/READY/SHORTLISTING/APPLYING/IN_FLIGHT/IN_PROCESS/CAUGHT_UP stay scannable. `list_companies` shows **every status by default — CLOSED and BLOCKED included** (30/page, most-recently-discussed first) so a name lookup ("is Reddit on my list?") can't miss a closed/blocked company; `status` is an optional _narrowing_ filter. Offer a revive, not a re-add, when a CLOSED/BLOCKED row turns up.

**Skip vs defer is chat-discipline-load-bearing.** Because "skip" colloquially reads as "for now" (≈ defer/pause), Hank picks the action by the user's **intent**, not the literal verb ("for now / set aside / hold" → pause; "not interested / pass for good" → close), prefers the reversible option when ambiguous, and bans "skip … for now" phrasing. It also doesn't re-ask for a reason it already has. Keep this intent-mapping in sync when you add/rename a reason.

### Tool-enforced invariants

Runtime gates the tools refuse to bypass. The system prompt repeats most; tool descriptions drift, so **this list is the source of truth**. Trying to bypass a guard is almost always wrong — the guards encode invariants downstream consumers silently depend on.

| Tool                                                       | Guard                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `update_job_interaction({status:'SHORTLISTED'})` / `commit_shortlist` | No round-completeness gate — a commit decides only the stanced rows; still-`NEW` stragglers wait on the board's "not read yet" tier. |
| `update_job_interaction({status:'CLOSED'})`                | Errors if `closeReason` missing.                                                                                            |
| `update_job_interaction({status:'DEFERRED'})`              | Errors if `deferReason` missing, or if a reason is paired with the wrong status. Any other status clears both reason pairs. |
| `update_job_interaction` (any field)                       | Writes the row directly and logs NO `JobEvent` — it's the correction path. Something that actually happened goes through `mark_job_applied` / `close_job` / `defer_job` / `log_job_events` so the timeline has it. |
| `caught_up_company`                                        | If any job is still `SCANNED` / `SHORTLISTED`, the first call sets nothing — it reports the open roles and asks Hank to confirm with the user, who re-calls with `confirmed: true`. `NEW` and `DEFERRED` don't block (an unreviewed backlog is what caught-up is *for*; a defer is a resolved hold). |
| `close_company` / `pause_company` / `block_company`        | Each takes a required `reason` from its **own** enum (`z.enum` over `COMPANY_CLOSE_REASONS` / `COMPANY_PAUSE_REASONS` / the block list) plus an optional `note`. One tool per status, so a reason can't be paired with the wrong one. |
| `create_jobs` / `update_job` (`sourceUrl`)                 | Errors on collision with an existing `Job.sourceUrl` (whole array rolls back); points at `update_job` on the existing row.  |
| `show_company` / `show_job` / `show_opportunity`           | Display only — put the entity's page on screen + drop a clickable `focus_ref` chip; change no state (non-handoff). No focus slot — focus is ephemeral. See [architecture.md](architecture.md#focus-vs-panel-view-dont-conflate-them). |
| `work_on_job({job})` / `company_walkthrough({company})`    | Engage: thread the entity into the walkthrough state machine as its `entryTarget` + hand off (job arm / company arm). A deferred `work_on_job` pick revives the role to `SHORTLISTED`.                                                    |
| `recommend_*_for_deletion`                                 | Never deletes; only flags (see the ladder above).                                                                          |

**Pause vs defer reasons are separate enums, on separate tools.** `JobDeferReason` (param `reason` on `defer_job`) and `CompanyPauseReason` (param `reason` on `pause_company`) are distinct sibling enums and both carry `OTHER`. Each tool validates a strict `z.enum` over its own offered list — [`JOB_DEFER_REASONS`](../src/server/entities/jobs/jobInteractionInputs.ts) and [`COMPANY_PAUSE_REASONS`](../src/server/entities/companies/companyInteractionInputs.ts) — which is also the list its JSON schema shows the model. The mix-up they used to guard against went away with the tools: the old `update_jobs_status` / `update_company_status` pair took a dynamic status plus whichever reason matched, so a job reason and a company reason were parameters of the same call; the per-status tools mean they never are. The cross-enum `validateDeferReason()` hint is deleted along with them.

## Opportunity (lead-with-jobs)

`Opportunity` is the **lead** — one inbound conversation thread anchored on a recruiter/referrer `Contact`. Pitched roles are regular `JobInteraction` rows linked via `JobInteraction.opportunityId` (starting at `PITCHED`) and walk the normal job pipeline; a lead can carry roles at different companies. The dashboard renders each lead as a group with its jobs inside. Rationale in [architecture.md → Opportunity owns the conversation](architecture.md#opportunity-owns-the-conversation-jobs-own-the-role-state).

**Lead-level state** (`Opportunity.status`) describes the conversation, not any single role. `OPPORTUNITY_EVENT_TO_STATUS` in [logOpportunityEvent.ts](../src/server/entities/opportunities/logOpportunityEvent.ts) maps event → status.

- `OPEN` (default) → `SCREENING` via `CALL_SCHEDULED` (or `create_opportunities([{nextStepAt}])`) → `AWAITING` via `NEXT_STEP_RECEIVED` → `CLOSED` via a `CLOSED` event (pair with `update_opportunity({closedReason})`). The lead doesn't auto-close when a linked job moves forward — the recruiter may still be pitching others.
- Events (`OpportunityEventType`): `INBOUND_RECEIVED` (once, on create) · `CALL_SCHEDULED` / `CALL_HAPPENED` · `NEXT_STEP_RECEIVED` · `STATUS_CHANGED` (bookkeeping) · `CLOSED` · `NOTE`. `INBOUND_RECEIVED` / `NOTE` / `STATUS_CHANGED` don't shift status. Legacy `ROLE_*` / `CONVERTED` values stay as tombstones; nothing emits them.
- There's no lead-level `DEFERRED` — `AWAITING` already covers the "they owe the next move" case that absorbs most defer-shaped scenarios.

**Adding a pitched role** (no promotion ceremony — the role _is_ a Job from day one): `create_jobs([{opportunity, title, company|companyName, …}])` creates a `Job` (with `companyId` null + `companyName` set when the hiring company is undisclosed) and a `JobInteraction(PITCHED)`, no `SURFACED` event; the normal pipeline takes over. When the hiring company firms up, `create_companies([{name}])` then `update_job({job, company})` attaches the FK (`companyName` auto-clears). `Opportunity.sourceJobInteractionId` optionally records when an inbound was triggered by an existing JobInteraction (surfaced as "Spawned from your apply to <Role>").

**"Make it go away" for opportunities:** no dedicated untrack/recommend ladder yet — the `CLOSED` status covers the soft-skip case; per-role declines use `close_job({job, reason})` on the linked role.
