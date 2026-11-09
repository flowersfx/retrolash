// Prompt library. Warm-up prompts are pure fun; retro prompts are playful
// but should surface real things about the sprint.

export const WARMUP_PROMPTS: string[] = [
  "The worst possible name for a sprint",
  "A new Jira status we desperately need",
  "The worst possible commit message",
  "What the build server dreams about at night",
  "A rejected agile ceremony",
  "A terrible thing to say at the start of a standup",
  "The real reason the deploy failed",
  "A motivational poster for the dev team",
  "A feature absolutely nobody asked for",
  "What the coffee machine would say in a retro",
  "The worst possible error message",
  "A product owner's secret superpower",
  "A dangerous thing to put in a story point estimate",
  "The worst name for a microservice",
  "What 'it works on my machine' really means",
  "A sticky note that should never go on the board",
  "The worst team-building activity",
  "Something you should never say to QA",
  "What the legacy code would say if it could talk",
  "A new Agile Manifesto value nobody agreed to",
  "The name of the team's first album",
  "A bad reason to cancel the sprint",
];

export const RETRO_PROMPTS: string[] = [
  "This sprint, described in five words",
  "If this sprint was a movie, its title would be…",
  "The thing that slowed us down the most",
  "Something we should stop doing immediately",
  "Something we should start doing",
  "A meeting that could have been a message",
  "The biggest surprise of the sprint",
  "What we'd do with one extra week",
  "The best moment of the sprint",
  "A risk nobody is talking about",
  "If our board could talk, it would say…",
  "Something that made you smile this sprint",
  "Our definition of done is secretly missing…",
  "The most confusing ticket, as a movie tagline",
  "A process we follow that nobody remembers the reason for",
  "What we'd tell ourselves at the start of the sprint",
  "The unsung hero of this sprint (person, tool or habit)",
  "The thing we keep saying we'll fix",
  "Our biggest win, as a newspaper headline",
  "If this sprint had a soundtrack, the song would be…",
  "One thing that should be easier than it is",
  "The weather report for this sprint",
];

/** Answer with emoji only. */
export const EMOJI_PROMPTS: string[] = [
  "This sprint, in three emoji",
  "Your Monday morning standup face",
  "The production incident, as told by emoji",
  "Our backlog right now",
  "What the CI pipeline feels like",
  "Your reaction when the scope changes mid-sprint",
  "The team's group chat after a release",
  "The legacy codebase, as a creature",
  "How the demo went",
  "Your inbox after one day off",
  "The perfect sprint, in emoji",
  "What really happens in code review",
  "The planning meeting in emoji",
  "Our tech debt, visualised",
];

/** "Help me" answers for when your mind goes blank. Deliberately generic. */
export const SAFETY_QUIPS: string[] = [
  "Synergy, but louder",
  "A spreadsheet with feelings",
  "Whatever the intern said",
  "Three raccoons in a trench coat",
  "It's always DNS",
  "A strongly worded sticky note",
  "Vibes-driven development",
  "The printer, somehow",
  "One more meeting about meetings",
  "A Jira ticket that achieved sentience",
  "Ctrl+Z, but for life",
  "Mysterious YAML",
  "A very confident guess",
  "Nobody knows, and that's the beauty of it",
];

export const SAFETY_EMOJI: string[] = [
  "🔥🐶☕", "🤡🎪🚀", "🙈🙉🙊", "📉😬📈", "🐌⏳💤", "🧯🔥🧯", "🤷‍♀️🤷🤷‍♂️", "🎢🤢🎉", "🦆🔍🐛",
];

/** Shown during the Sprint discussion pause, to turn laughs into talk. */
export const DISCUSSION_QUESTIONS: string[] = [
  "Is there something real behind the winning answer?",
  "What would have prevented this?",
  "Who else felt this way?",
  "What's one small thing we could try next sprint?",
  "Is this a one-off, or a pattern?",
  "What did we learn here?",
  "What should we keep doing?",
  "Does anyone see this differently?",
  "What's the smallest fix that would help?",
  "If we ignore this, what happens next sprint?",
];

/** Big-screen commentary. Picked deterministically per moment, so it doesn't flicker. */
export const COMMENTARY = {
  voting: [
    "Choose wisely. The burndown chart is watching.",
    "Vote with your heart. Or your sense of humour.",
    "No pressure, but history will remember this.",
    "Take your time. Actually, don't, there's a timer.",
    "Somewhere, a scrum master is taking notes.",
  ],
  unanimous: [
    "A clean sweep! Not a single dissenting vote.",
    "Total consensus. Mark the calendar.",
    "Everyone agreed on something. A retro first.",
  ],
  close: [
    "That was close. Like a Friday deploy.",
    "Neck and neck!",
    "Photo finish!",
  ],
  tie: ["A perfect tie. Diplomacy wins.", "Dead even. Nobody wins, nobody cries."],
  blowout: ["Not even close.", "A decisive victory.", "The people have spoken, loudly."],
  answering: [
    "Thinking music intensifies…",
    "The best answers are written in the last 10 seconds.",
    "Stuck? There's a help button on your phone.",
    "Remember: there are no wrong answers. Only funny ones.",
  ],
  roundDone: [
    "The leaderboard has shifted.",
    "Stretch, sip some coffee, get ready.",
    "Points are temporary. Retro insights are forever.",
  ],
};

/** Stable pick from a list based on a string seed (e.g. a matchup id). */
export function pick<T>(items: readonly T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return items[Math.abs(h) % items.length];
}

export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
