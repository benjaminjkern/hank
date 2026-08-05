export type Persona = {
  // Stable kebab id — used in filenames, emails, report names.
  id: string;
  displayName: string;
  // 2-4 sentences of background the model role-plays.
  bio: string;
  // What this user wants out of the session (drives goalProgress).
  goals: string[];
  // Behavioral constraints / personality knobs.
  constraints: string[];
  // The very first thing on their mind when they open Hank.
  openingIntent: string;
};
