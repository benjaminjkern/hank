export interface Theme {
  colors: {
    bg: string;
    bgPanel: string;
    bgMuted: string;
    bgHover: string;
    border: string;
    borderStrong: string;
    text: string;
    textMuted: string;
    textSubtle: string;
    accent: string;
    accentHover: string;
    danger: string;
    success: string;
    onAccent: string;
    // Background for a row/card that is the current focus target. Distinct
    // from `bgHover` so a hovered focused row still gets a visible delta
    // (otherwise focus + hover collide and the UI reads as broken).
    bgFocused: string;
    // Status-tone palette. statusColors.ts maps every JobInteractionStatus /
    // CompanyStatus / OpportunityStatus into one of seven tones:
    //   focusNow   (Hank purple) — Hank's focus, mid-flight work the user actively drives
    //   notStarted (dark grey)   — surfaced but not yet triaged
    //   resting    (green)       — applied/scheduled, ball's in their court ("In flight")
    //   watching   (teal)        — CAUGHT_UP: on the list, idle, watching for new roles
    //   deferred   (amber)       — explicit "paused, will revisit" (DEFERRED)
    //   blocked    (slate)       — BLOCKED: couldn't read the board (technical set-aside)
    //   closed     (red)         — skipped / rejected / closed
    // resting vs watching and deferred vs blocked are deliberately distinct colors
    // so the dashboard's "In flight"/"Watching" and "Deferred"/"Blocked" buckets
    // don't read as the same thing. The focusNow tone shares the brand accent so
    // "Hank's color" carries the urgency cue across pills + the focus pill.
    // Authoritative mapping + meanings live in [docs/lifecycle.md](../../docs/lifecycle.md).
    focusNow: string;
    notStarted: string;
    resting: string;
    watching: string;
    deferred: string;
    blocked: string;
    closed: string;
    // Applied-aging escalation. An APPLIED job with no response yet starts on
    // the `resting` green, then climbs these three as it goes stale waiting on
    // the employer: yellow at 2 weeks, orange at 30 days, red at 60. Used only
    // by jobStatusColor() in statusColors.ts for APPLIED job pills.
    agingYellow: string;
    agingOrange: string;
    agingRed: string;
  };
  space: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    xxl: string;
  };
  radius: {
    sm: string;
    md: string;
    lg: string;
  };
  font: {
    body: string;
    mono: string;
  };
  size: {
    topBar: string;
    inputBar: string;
  };
  breakpoints: {
    // Below this width the chat + right panel switch from side-by-side to
    // single-panel + tabs. Use as `@media (max-width: ${theme.breakpoints.narrow})`.
    narrow: string;
  };
}

const space: Theme["space"] = {
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "32px",
};

const radius: Theme["radius"] = {
  sm: "4px",
  md: "8px",
  lg: "12px",
};

const font: Theme["font"] = {
  body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const size: Theme["size"] = {
  topBar: "52px",
  inputBar: "84px",
};

const breakpoints: Theme["breakpoints"] = {
  narrow: "900px",
};

export const darkTheme: Theme = {
  colors: {
    bg: "#0c0c0e",
    bgPanel: "#141418",
    bgMuted: "#1c1c22",
    bgHover: "#22222a",
    border: "#2a2a32",
    borderStrong: "#3a3a44",
    text: "#ededf0",
    textMuted: "#9a9aa3",
    textSubtle: "#6a6a73",
    accent: "#a16dff",
    accentHover: "#b78aff",
    danger: "#e06c75",
    success: "#7cd992",
    onAccent: "#0c0c0e",
    bgFocused: "#1f1a2a", // subtle accent-purple tint over bg
    focusNow: "#a16dff", // Hank brand purple — carries the "deal with this now" cue
    notStarted: "#7a7a85", // dark grey — surfaced but not triaged
    resting: "#7cd992", // same as success — "In flight" (applied, ball in their court)
    watching: "#56c1cc", // teal — CAUGHT_UP, idle, watching for new roles
    deferred: "#e8a04c", // warm amber — "paused, will revisit"
    blocked: "#7e90b3", // cool slate — BLOCKED, couldn't read the board
    closed: "#e06c75", // same as danger
    agingYellow: "#e8cf4c", // applied 2w+ — yellow
    agingOrange: "#e8843c", // applied 30d+ — orange
    agingRed: "#e06c75", // applied 60d+ — red (same as danger/closed)
  },
  space,
  radius,
  font,
  size,
  breakpoints,
};

export const lightTheme: Theme = {
  colors: {
    bg: "#fafafb",
    bgPanel: "#ffffff",
    bgMuted: "#f1f1f4",
    bgHover: "#e7e7ec",
    border: "#e2e2e8",
    borderStrong: "#cdcdd5",
    text: "#1a1a1f",
    textMuted: "#5c5c66",
    textSubtle: "#8a8a94",
    accent: "#8b53f5",
    accentHover: "#7a3fe8",
    danger: "#d14a55",
    success: "#3aa860",
    onAccent: "#ffffff",
    bgFocused: "#ede5f7", // subtle accent-purple tint over bg
    focusNow: "#8b53f5", // Hank brand purple — same as accent
    notStarted: "#5a5a64", // dark grey
    resting: "#3aa860", // green — "In flight" (applied, ball in their court)
    watching: "#2d8f9d", // teal — CAUGHT_UP, idle, watching for new roles
    deferred: "#b8722a", // warm amber — "paused, will revisit"
    blocked: "#5f6e92", // cool slate — BLOCKED, couldn't read the board
    closed: "#d14a55",
    agingYellow: "#a8851a", // applied 2w+ — yellow (darkened for light-bg contrast)
    agingOrange: "#c2641e", // applied 30d+ — orange
    agingRed: "#d14a55", // applied 60d+ — red (same as danger/closed)
  },
  space,
  radius,
  font,
  size,
  breakpoints,
};
