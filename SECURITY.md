# Security Policy

Hank is an early-stage open-source project and has not been through a formal
security audit. If you self-host it, run it as your own single-tenant
deployment behind your own auth and network controls — it is not hardened for
hostile multi-tenant use.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's
[security advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab) rather than
opening a public issue. There is no formal SLA, but reports are welcome and
appreciated.

## Known limitations

- **Outbound fetch (SSRF).** Hank fetches agent- and user-supplied URLs by
  design. A pre-flight guard
  (`src/server/platform/net/assertPublicUrl.ts`) blocks loopback, private-range,
  link-local (including cloud-metadata addresses), and multicast destinations,
  but it does not re-validate redirect hops and does not defend against DNS
  rebinding. A hardened deployment should also restrict the app's outbound
  network egress at the infrastructure level.
- **Headless browser.** Some job boards are scraped with a headless Chromium
  launched with `--no-sandbox` (required in the container runtime). It
  navigates scrape-derived URLs; treat the scrape network path as trusted-input
  only.
