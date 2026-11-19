// Usage summary from DATA_DIR/usage.jsonl (one JSON line per game start and
// finish, counts only). Used by /api/stats (the landing page) and
// scripts/usage.ts. Test games are left out unless asked for.

export interface UsageLine {
  event: "start" | "game";
  at: string;
  game?: string;
  players: number;
  audience: number;
  bots?: number;
  minutes?: number;
  active?: number;
  actionItems?: number;
  owned?: number;
  kudos?: number;
  autoAnswers?: number;
  screens?: number;
  vip?: boolean;
  lang?: string;
  speech?: boolean;
  anonymous?: boolean;
  [k: string]: unknown;
}

export interface UsageSummary {
  /** Finished real games. */
  games: number;
  thisMonth: number;
  /** Average players who took part (falls back to the player list for old lines). */
  players: number;
  minutes: number;
  actionItems: number;
  /** Share of action items that got an owner, 0–1. */
  ownedShare: number;
  kudos: number;
  /** Started (with a game id) but never finished, not counting games that may still be running. */
  abandoned: number;
  /** Games that had at least one extra screen. */
  withScreens: number;
  swedish: number;
  speech: number;
  anonymous: number;
  lastPlayed: string | null;
  perMonth: Record<string, number>;
  /** Lines left out as tests. */
  tests: number;
}

/**
 * A bot game: it had test bots, or (older lines, written before bots were
 * counted) it finished in under 8 minutes, which no real retro does.
 */
export function isTest(e: UsageLine) {
  if (typeof e.bots === "number") return e.bots > 0;
  return e.event === "game" ? (e.minutes ?? 0) < 8 : false;
}

export function parseUsage(text: string): UsageLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return e && (e.event === "start" || e.event === "game") && typeof e.at === "string" ? [e as UsageLine] : [];
      } catch {
        return [];
      }
    });
}

export function summarize(lines: UsageLine[], opts: { includeTests?: boolean; now?: Date } = {}): UsageSummary {
  const now = opts.now ?? new Date();
  const real = opts.includeTests ? lines : lines.filter((e) => !isTest(e));
  const games = real.filter((e) => e.event === "game");
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const share = (f: (g: UsageLine) => boolean) => (games.length ? games.filter(f).length / games.length : 0);
  const sum = (f: (g: UsageLine) => number) => games.reduce((a, g) => a + f(g), 0);
  const month = now.toISOString().slice(0, 7);
  const perMonth: Record<string, number> = {};
  for (const g of games) perMonth[g.at.slice(0, 7)] = (perMonth[g.at.slice(0, 7)] ?? 0) + 1;
  const finished = new Set(games.map((g) => g.game).filter(Boolean));
  const stillRunning = (e: UsageLine) => now.getTime() - Date.parse(e.at) < 3 * 3600_000;
  const items = sum((g) => g.actionItems ?? 0);
  return {
    games: games.length,
    thisMonth: perMonth[month] ?? 0,
    players: avg(games.map((g) => g.active ?? g.players)),
    minutes: avg(games.map((g) => g.minutes ?? 0)),
    actionItems: items,
    ownedShare: items ? sum((g) => g.owned ?? 0) / items : 0,
    kudos: sum((g) => g.kudos ?? 0),
    abandoned: real.filter((e) => e.event === "start" && e.game && !finished.has(e.game) && !stillRunning(e)).length,
    withScreens: games.filter((g) => (g.screens ?? 0) > 0).length,
    swedish: share((g) => g.lang === "sv"),
    speech: share((g) => !!g.speech),
    anonymous: share((g) => !!g.anonymous),
    lastPlayed: games.length ? games[games.length - 1].at : null,
    perMonth,
    tests: lines.length - real.length,
  };
}
