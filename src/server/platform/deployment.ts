// How THIS instance is configured to be used — the three knobs that decide who
// can sign in and whose API key pays. Read once at import; changing any of them
// needs a restart.
//
// Defaults describe the case someone hits first: they cloned the repo, put a
// DeepSeek key in .env, and want it working. So auth is off and the server key
// is shared. A deployment serving other people flips all three — see
// docs/self-hosting.md.

export type AuthMode = "local" | "oauth";

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

// Throws rather than falling back, because every silent misread here fails
// open: `ALLOW_USER_API_KEYS=yes` quietly read as false is a confusing support
// ticket, but read as true on a public instance is an open sign-up.
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  throw new Error(
    `${name} must be one of true/false/1/0/yes/no/on/off — got "${process.env[name]}"`,
  );
}

function envAuthMode(): AuthMode {
  const raw = process.env.AUTH_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "local";
  if (raw === "local" || raw === "oauth") return raw;
  throw new Error(`AUTH_MODE must be "local" or "oauth" — got "${raw}"`);
}

/**
 * "local" — sign in by typing an email. No password, no verification: whoever
 * can reach the page can become any account on it. Right for a machine only you
 * can reach; never right for a public URL.
 *
 * "oauth" — Google / GitHub, the providers configured below.
 */
export const authMode: AuthMode = envAuthMode();

/** Which OAuth providers have credentials. A button renders only if its pair is set. */
export const oauthProviders = {
  google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
  github: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
};

/**
 * Whether every account may spend the server's API key.
 *
 * true — the single-user default: the key in .env just works.
 * false — an account can only spend it once an admin grants
 * `User.canUseServerKey` at /admin/users. That grant IS the invite gate on a
 * public deployment: an ungranted user can sign in but can't run the agent, so
 * they never generate a transcript or a profile.
 */
export const serverKeyByDefault = envFlag("SERVER_KEY_BY_DEFAULT", true);

/**
 * Whether users may save their own API keys.
 *
 * Off by default. Turning it on means anyone who can sign in can use the app on
 * their own dime — which also means their personal data lands in your database
 * without you approving them one at a time. That configuration needs a privacy
 * policy and terms of service; see docs/self-hosting.md.
 */
export const allowUserApiKeys = envFlag("ALLOW_USER_API_KEYS", false);

/**
 * Whether `userGrant` (the `User.canUseServerKey` column) plus this instance's
 * policy add up to server-key access. The single answer to that question — the
 * key resolvers, the session callback, and the first-load chat gate all ask it
 * here rather than re-implementing the `||`.
 */
export function hasServerKeyAccess(userGrant: boolean): boolean {
  return userGrant || serverKeyByDefault;
}

// Local auth on a real deployment is the one combination that's dangerous
// rather than merely permissive, and it's reachable by deploying the defaults.
// The sign-in page says so too — this is for whoever reads the boot log.
if (authMode === "local" && process.env.NODE_ENV === "production") {
  console.warn(
    "[hank] AUTH_MODE=local in production: anyone who can reach this URL can " +
      "sign in as any account, including an admin. Set AUTH_MODE=oauth to " +
      "require a real identity.",
  );
}
