# Self-hosting Hank

There are two very different situations here, and almost everything on this page
depends on which one you're in:

1. **You're running Hank for yourself.** Your data, your machine, your API key.
   Nothing below is an obligation — read the first section and stop.
2. **You're running Hank for other people**, even a handful of friends. You are
   now storing personal information on their behalf, and the rest of this page
   is the list of things to know before you do.

Hank ships configured for case 1.

## Running it for yourself

The defaults are single-user shaped: sign-in is OAuth against apps you register,
there's no public sign-up flow, and the server API key is the one in your `.env`.
Nothing is exposed until you deploy it somewhere public.

If you deploy to a public URL and don't want strangers signing in, see
[Keeping a public deployment closed](#keeping-a-public-deployment-closed).

## What Hank stores about a user

Hank is a job-search assistant, so it accumulates an unusually complete picture
of someone's working life. Even a user who never uploads a résumé will tell it
about compensation expectations, location constraints, visa status, and why they
left their last job — because it asks.

| Data                    | Where it lives                                                    |
| ----------------------- | ----------------------------------------------------------------- |
| Résumé / attachment file bytes | `Resume` and `Attachment` tables — raw bytes in Postgres    |
| Full chat transcripts   | `ChatMessage`                                                      |
| A distilled personal profile | `MemoryNote` — `profile.md`, `resume.md`, `frequent_questions.md`, plus per-company and per-job notes |
| Job-search activity     | `JobInteraction`, `CompanyInteraction`, `JobEvent`, `CompanyEvent` — where they applied and what happened |
| Recruiter contacts       | `Contact`, `Opportunity`                                          |
| LLM API keys            | `User.deepseekKeyEncrypted` / `anthropicKeyEncrypted` — AES-256-GCM encrypted at rest, bound to the owning user (see [SECURITY.md](../SECURITY.md)) |
| OAuth identity          | `User`, `Account` — email, display name, avatar URL               |
| Prompt captures         | `SubAgentRun.input` stores the prompt **as sent to the model**, which includes résumé text and profile details |

That last row is the one people miss: the sub-agent capture table is a debugging
aid that happens to retain a copy of personal content. It's worth knowing about
before you decide how long to keep rows.

## Who can read it

**Admin users can read everything.** `/admin/*` includes a view-session mode that
loads any user's chat session read-only ([docs/admin.md](admin.md)). This is
deliberate — it's how you debug what the agent actually did — but it means the
admin account is a privileged position over every other user's data. Grant
`isAdmin` accordingly.

## Where the data goes

Hank sends user content to third-party APIs. If you run it for other people, this
is the part your users most need told to them:

- **DeepSeek** receives every chat message, and the assembled prompts — which
  include résumé content and profile notes — because it runs the main agent and
  all sub-agents.
- **Anthropic** receives résumé files and company logo images, for the two
  vision-only features.

Which provider runs which call is fixed in code, not configurable — see
[docs/llm-providers.md](llm-providers.md). Consult each provider's current terms
for how they handle API data; don't rely on this page for that.

## What Hank does not have

Stated plainly, because you'd otherwise find out later:

- **No account deletion.** There is no self-serve delete, and no admin button.
  Removing a user means deleting rows by hand.
- **No data export.**
- **No retention policy.** Nothing ages out. Transcripts, prompt captures, and
  résumé bytes persist until someone deletes them.
- **No consent flow.** There is no terms-of-service gate or privacy notice at
  sign-in.

None of this matters for a single-user deployment. All of it matters the moment
someone else's data is in your database.

## Keeping a public deployment closed

Hank has a built-in gate, and it's the per-user `canUseServerKey` flag — `false`
by default for every new account. A user with no key of their own and no grant
can sign in but can't use the agent.

So a public deployment where you approve people individually is the default
behavior, not a feature you have to build:

1. Deploy with `DEEPSEEK_API_KEY` set as the server key.
2. Leave `canUseServerKey` at its default for new sign-ups.
3. Grant it per user at `/admin/users` when you decide to let someone in.

Users who sign in but aren't granted can't run the agent, so they never generate
transcripts or profile notes. Their `User` row (email, name, avatar from OAuth)
is created, which is a much smaller footprint than an active account.

If you'd rather let anyone in on their own dime, users can save their own API key
in Settings and use Hank without a grant. **That's the configuration that needs a
privacy policy and terms of service** — you're accepting arbitrary sign-ups whose
personal data lands in your database.

## If you run Hank for other people

A short list, not legal advice — talk to someone qualified if the stakes warrant
it:

- Publish your own privacy policy and terms. **Don't reuse another deployment's**
  — it names a different operator, a different database, and a different
  retention practice.
- Disclose the third-party processors above by name.
- Decide, and write down, how someone asks you to delete their data — and be
  aware you'll be doing it with SQL.
- Restrict `isAdmin` to people who should be able to read every user's job
  search.
- Read the known limitations in [SECURITY.md](../SECURITY.md), especially the
  outbound-fetch (SSRF) section, before exposing the app to untrusted users.
