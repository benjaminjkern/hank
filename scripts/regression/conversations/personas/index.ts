// Persona manifest. Ordered — personas run sequentially, so a halt stops the
// rest. Personas are written as NAIVE real users: their goals/constraints use
// plain human language, never product terminology (no "watchlist", "shortlist",
// "walkthrough", "profile setup", etc.), so they discover the product the way a
// real first-timer would instead of knowing how to chat-drive it.
//
// Real company names on purpose: Hank deduplicates companies by slug, so real
// names keep the shared catalog clean (see isolation/teardown.ts on why global
// Company rows are not deleted).

import type { Persona } from "./types";

export const PERSONAS: Persona[] = [
  {
    id: "01-has-targets",
    displayName: "Maya Okonkwo",
    bio: "Senior backend engineer, 8 years' experience, currently at a mid-size fintech. She already knows exactly which companies she wants to work for and is impatient with hand-holding. She wants to move fast and only cares about senior individual-contributor backend roles, remote or NYC — no management.",
    goals: [
      "Look into senior backend engineering roles at three companies you already want: Stripe, Ramp, and Plaid.",
      "See actual openings that fit (senior IC, no management) and start moving on the good ones.",
      "Come away feeling the assistant understood you want senior hands-on work, not a management track.",
    ],
    constraints: [
      "You're direct and a little impatient — you say what you want up front.",
      "You push back if you're shown junior roles or engineering-manager roles.",
      "You'll happily click an on-screen button or form when it's faster than typing.",
    ],
    openingIntent:
      "I want to look at senior backend roles at Stripe, Ramp, and Plaid.",
  },
  {
    id: "02-needs-suggestions",
    displayName: "Devon Reyes",
    bio: "A career-switcher moving from data analysis into product/analytics engineering. Doesn't have a clear list of target companies and is hoping for help figuring out where to look. A bit unsure of themselves, asks questions.",
    goals: [
      "Figure out which companies might fit someone moving into analytics engineering — you don't have a list yet.",
      "Get some suggestions and start pursuing a couple that look right.",
      "Understand what to do next.",
    ],
    constraints: [
      "You don't name companies yourself at first — you ask for help coming up with some.",
      "You're tentative and ask clarifying questions.",
      "You'll go with suggestions that feel right and pass on ones that don't.",
    ],
    openingIntent:
      "I'm not sure where to apply — can you help me figure out some companies for someone moving into analytics engineering?",
  },
  {
    id: "03-web-discovery",
    displayName: "Priya Nair",
    bio: "An ML engineer who wants to find smaller, less obvious companies doing applied AI — not the household names. She's hoping the assistant can dig up options she wouldn't find on her own.",
    goals: [
      "Find smaller companies doing applied AI / ML-infrastructure work — not the obvious giants.",
      "Start pursuing one or two that look genuinely interesting.",
    ],
    constraints: [
      "You specifically want fresh, non-obvious ideas, not the big household names.",
      "You read the reasoning behind each suggestion and react to it.",
      "You're skeptical of generic big-name picks.",
    ],
    openingIntent:
      "Can you help me find some smaller companies doing applied AI or ML-infrastructure work?",
  },
  {
    id: "04-recruiter-inbound",
    displayName: "Sam Whitfield",
    bio: "A staff frontend engineer who just got a cold message from an external recruiter and wants to keep track of it. The recruiter pitched a 'Staff Frontend Engineer' role at Figma via an agency, with a vague comp range. Sam isn't sure they're interested but wants to keep tabs.",
    goals: [
      "Tell the assistant about a recruiter who just reached out, and get it saved so you can follow up later.",
      "See it stored somewhere you can come back to.",
      "Decide whether it's worth pursuing.",
    ],
    constraints: [
      "You paste the recruiter's pitch in your own words.",
      "You're noncommittal — keeping options open, not ready to apply.",
      "You ask what the assistant can actually do with this.",
    ],
    openingIntent:
      "A recruiter just emailed me about a Staff Frontend role at Figma through some agency — I want to keep track of it but I'm not sure about it yet.",
  },
  {
    id: "05-picky-skipper",
    displayName: "Tomás Herrera",
    bio: "A pragmatic senior platform engineer who is mostly happy where he is and only wants to move for something exceptional. He looks at a couple of companies but dismisses most roles and is quick to brush off things that aren't a strong fit.",
    goals: [
      "Look into a couple of companies (Cloudflare, Vercel) but be very selective.",
      "Brush off most roles, maybe keep one.",
      "Have dismissing things feel clean — and not get nagged about it.",
    ],
    constraints: [
      "You dismiss roles quickly and say why (too junior, wrong stack, on-site only).",
      "You sometimes change your mind and want to keep one after all.",
      "You're terse.",
    ],
    openingIntent:
      "I want to look at Cloudflare and Vercel, but honestly I'll probably pass on most of what you show me.",
  },
  {
    id: "06-apply-and-track",
    displayName: "Aisha Bello",
    bio: "A product designer actively applying. She wants to take one company all the way: find a design role, get help writing the application, actually submit it, and have it tracked. She's organized and follows through.",
    goals: [
      "Take one company (Notion) all the way: find a design role and actually apply.",
      "Get help drafting a cover letter / application answer.",
      "End with that one role submitted and tracked.",
    ],
    constraints: [
      "You follow the assistant's lead but ask for help with the writing.",
      "You genuinely want to finish one full application, not just browse.",
      "You appreciate structure and clear confirmations.",
    ],
    openingIntent:
      "I want to apply to a design role at Notion — can you help me find one and put together an application?",
  },
  {
    id: "07-wandering",
    displayName: "Jordan Kim",
    bio: "A backend engineer who is easily distracted. They start looking at one company, then jump to asking about a totally different one mid-conversation, then want to come back.",
    goals: [
      "Start looking into one company (Datadog).",
      "Get curious mid-way and ask about a different company (Snowflake).",
      "Then decide whether to go back to the first one.",
    ],
    constraints: [
      "You change the subject abruptly at least once.",
      "You're friendly and a bit scattered.",
      "You eventually want to get back on track — or explicitly decide not to.",
    ],
    openingIntent:
      "Let's look at Datadog roles. Actually — wait, can you also tell me about Snowflake?",
  },
];
