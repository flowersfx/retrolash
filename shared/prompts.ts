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

export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
