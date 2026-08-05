# Security Policy

Hank is an early-stage personal project shared as open source. It has not been
through a formal security audit. If you self-host it, run it as your own
single-tenant deployment behind your own auth and network controls — it is not
hardened for hostile multi-tenant use.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's
[security advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab) rather than
opening a public issue. There is no formal SLA, but reports are welcome and
appreciated.

## Handling of secrets

- Per-user LLM API keys are encrypted at rest with AES-256-GCM, with the
  ciphertext bound to the owning `(userId, provider)` as GCM additional
  authenticated data (see `src/server/platform/llm/keyCrypto.ts`). A blob copied
  into another row fails to decrypt rather than silently billing the wrong
  account.
- The master key (`ANTHROPIC_KEY_ENCRYPTION_KEY`), OAuth secrets, and the
  database URL are read from environment variables and are never committed.
  `.env` is gitignored; `.env.example` holds only placeholders.

## Known limitations

- **Outbound fetch (SSRF).** Hank fetches caller-supplied URLs by design — the
  `fetch_url` tool and careers-page board discovery both take a URL from the
  agent or user. A pre-flight guard (`src/server/platform/net/assertPublicUrl.ts`)
  runs before those fetches: it resolves the host and blocks loopback, private
  (RFC-1918), CGNAT, link-local (including the `169.254.169.254` cloud-metadata
  address), unique-local, and multicast destinations, checking every resolved
  answer and both the IPv4-mapped and NAT64 IPv6 forms. It is **not** airtight:
  it does not re-validate redirect hops (fetches follow redirects) and does not
  defend against DNS rebinding, and the ATS provider scrapers reach board API
  endpoints built from a detected ATS slug without re-running it. A hardened
  deployment should also restrict the app's outbound network egress at the
  infrastructure level.
- **Headless browser.** Some ATS providers are scraped with a headless Chromium
  launched with `--no-sandbox` (required in the container runtime). It navigates
  scrape-derived URLs; treat the scrape network path as trusted-input only.
