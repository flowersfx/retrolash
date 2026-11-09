// Shared protocol between the game server and the React clients.

export type RoundKind = "checkin" | "followup" | "warmup" | "emoji" | "retro" | "lastlash";

/** Rounds the facilitator can switch on/off, in play order. "followup" is automatic. */
export const TOGGLEABLE_ROUNDS: RoundKind[] = ["checkin", "warmup", "emoji", "retro", "lastlash"];

/** Head-to-head rounds: everyone gets two prompts, answers go up against each other. */
export const isHeadToHead = (k: RoundKind | undefined) =>
  k === "warmup" || k === "emoji" || k === "retro";

export interface Settings {
  /** Hide who wrote what, and hide scores. */
  anonymous: boolean;
  rounds: RoundKind[];
  answerSeconds: number;
  voteSeconds: number;
  /** Facilitator-written prompts, mixed into the retro round first. */
  customPrompts: string[];
  /** The prompt used for the final "action items" round. */
  lashPrompt: string;
  /** How many answers each player may submit in the final round. */
  lashMaxAnswers: number;
  /** How many votes each player gets in the final round. */
  lashVotes: number;
  /** Number of "The Sprint" rounds. 0 = automatic (based on player count). */
  sprintRounds: number;
  /** Discussion time after each Sprint matchup. 0 = wait for the facilitator. */
  discussionSeconds: number;
  /** Last retro's action items, revisited in a "Did we do it?" round. */
  previousItems: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  anonymous: false,
  rounds: ["checkin", "warmup", "emoji", "retro", "lastlash"],
  answerSeconds: 90,
  voteSeconds: 25,
  customPrompts: [],
  lashPrompt: "One concrete thing we should change next sprint",
  lashMaxAnswers: 2,
  lashVotes: 3,
  sprintRounds: 0,
  discussionSeconds: 60,
  previousItems: [],
};

/** How many Sprint rounds "auto" gives: at least two, three for tiny teams. */
export function autoSprintRounds(players: number) {
  return players <= 3 ? 3 : 2;
}

/** The actual sequence of rounds a game will play. */
export function planRounds(settings: Settings, players: number): RoundKind[] {
  const plan: RoundKind[] = [];
  const on = new Set(settings.rounds);
  const followup = settings.previousItems.length > 0;
  if (on.has("checkin")) plan.push("checkin");
  if (followup) plan.push("followup");
  if (on.has("warmup")) plan.push("warmup");
  if (on.has("emoji")) plan.push("emoji");
  if (on.has("retro")) {
    const n = settings.sprintRounds || autoSprintRounds(players);
    for (let i = 0; i < n; i++) plan.push("retro");
  }
  if (on.has("lastlash")) plan.push("lastlash");
  return plan;
}

export type Phase =
  | "lobby"
  | "roundIntro"
  | "answering"
  | "voting"
  | "matchupResult"
  | "roundResult"
  | "pollResult"
  | "lashVoting"
  | "lashResult"
  | "summary";

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  connected: boolean;
  score: number;
  /** Audience members vote and react, but don't answer or score. */
  audience?: boolean;
}

/** A finished or in-progress head-to-head, as shown on screen. */
export interface MatchupView {
  id: string;
  prompt: string;
  answers: [string, string];
  /** Only revealed in non-anonymous mode, after voting. */
  authors?: [string, string];
  /** Vote counts, only after voting closes. */
  votes?: [number, number];
  /** Who voted for each side (names), only in non-anonymous mode after voting. */
  voterNames?: [string[], string[]];
  /** Voters' avatars per side, only in non-anonymous mode after voting. */
  voterAvatars?: [string[], string[]];
  /** Points awarded per side, only in non-anonymous mode. */
  points?: [number, number];
  unanimous?: boolean;
}

export interface LashAnswerView {
  id: string;
  text: string;
  votes?: number;
  author?: string;
  /** People who volunteered to own this action item (always shown). */
  owners?: { name: string; avatar: string }[];
}

export const MOODS = [
  { emoji: "☀️", label: "Sunny" },
  { emoji: "🌤️", label: "Mostly good" },
  { emoji: "☁️", label: "Meh" },
  { emoji: "🌧️", label: "Rough" },
  { emoji: "⛈️", label: "Stormy" },
] as const;

export const FOLLOWUP_OPTIONS = [
  { emoji: "✅", label: "Done" },
  { emoji: "🟡", label: "Partly" },
  { emoji: "❌", label: "Not done" },
] as const;

export interface FollowupItemView {
  text: string;
  /** Counts per FOLLOWUP_OPTIONS index. */
  counts: number[];
}

export interface SummaryRound {
  kind: RoundKind;
  title: string;
  matchups: MatchupView[];
  lashPrompt?: string;
  lashAnswers?: LashAnswerView[];
  /** Check-in: counts per MOODS index. */
  moodCounts?: number[];
  followupItems?: FollowupItemView[];
}

/** What the big screen receives. */
export interface HostView {
  role: "host";
  code: string;
  phase: Phase;
  settings: Settings;
  players: PublicPlayer[];
  roundNumber: number;
  roundCount: number;
  roundKind?: RoundKind;
  roundTitle?: string;
  /** The planned rounds (in the lobby: what Start would play now). */
  plan: { kind: RoundKind; title: string }[];
  /** Milliseconds left on the current timer at send time. */
  remainingMs: number | null;
  /** Set while the facilitator holds the timer: what was left. */
  pausedMs: number | null;
  /** Player ids that have finished the current task (answering/voting). */
  doneIds: string[];
  /** Player ids expected to act in the current phase. */
  expectedIds: string[];
  matchup?: MatchupView;
  matchupNumber?: number;
  matchupCount?: number;
  lashPrompt?: string;
  lashAnswers?: LashAnswerView[];
  /** pollResult of a check-in round. */
  moodCounts?: number[];
  /** pollResult of a follow-up round. */
  followupItems?: FollowupItemView[];
  summary?: SummaryRound[];
}

export interface PromptTask {
  matchupId: string;
  prompt: string;
  answer: string | null;
}

/** What a phone receives. */
export interface PlayerView {
  role: "player";
  code: string;
  phase: Phase;
  you: PublicPlayer | null;
  anonymous: boolean;
  remainingMs: number | null;
  roundKind?: RoundKind;
  roundTitle?: string;
  /** Answering phase (head-to-head rounds). */
  tasks?: PromptTask[];
  /** Answering phase (last lash). */
  lashPrompt?: string;
  lashMaxAnswers?: number;
  myLashAnswers?: string[];
  /** Answering phase (check-in). */
  myMood?: number | null;
  /** Answering phase (follow-up): the items and my answers so far. */
  followup?: { items: string[]; mine: (number | null)[] };
  /** Voting phase (head-to-head). */
  vote?: {
    matchupId: string;
    prompt: string;
    answers: [string, string];
    canVote: boolean;
    myChoice: 0 | 1 | null;
  };
  /** Voting phase (last lash). */
  lashBallot?: {
    answers: { id: string; text: string; mine: boolean }[];
    votesAllowed: number;
    myVotes: string[];
    submitted: boolean;
  };
  /** Last Lash results: top items people can volunteer to own. */
  claimable?: { id: string; text: string; votes: number; owners: string[]; mine: boolean }[];
  playerCount: number;
  minPlayers: number;
}

export type ServerMessage =
  | { t: "view"; view: HostView | PlayerView }
  | { t: "error"; message: string }
  /** Sent to the big screen only. */
  | { t: "reaction"; emoji: string; avatar?: string };

export type ClientMessage =
  | { t: "helloHost" }
  | { t: "helloPlayer"; name: string; audience?: boolean }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "start" }
  | { t: "next" }
  | { t: "hold" }
  | { t: "kick"; playerId: string }
  | { t: "restart" }
  | { t: "answer"; matchupId: string; text: string }
  | { t: "lashAnswers"; texts: string[] }
  | { t: "vote"; matchupId: string; choice: 0 | 1 }
  | { t: "lashVote"; answerIds: string[] }
  | { t: "mood"; value: number }
  | { t: "followup"; answers: (number | null)[] }
  | { t: "claim"; answerId: string; on: boolean }
  | { t: "react"; emoji: string };

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 16;
export const MAX_AUDIENCE = 40;
export const MAX_ANSWER_LENGTH = 80;
export const MAX_EMOJI_LENGTH = 40;
export const MAX_LASH_LENGTH = 120;
export const MAX_PREVIOUS_ITEMS = 10;

export const REACTIONS = ["😂", "🔥", "👏", "😮", "🙈", "💯"];

export const ROUND_TITLES: Record<RoundKind, string> = {
  checkin: "Check-in",
  followup: "Did we do it?",
  warmup: "Warm-up",
  emoji: "Emoji Only",
  retro: "The Sprint",
  lastlash: "Last Lash: Action Items",
};

/** Title for the n-th (0-based) occurrence of a round kind in the plan. */
export function roundTitle(kind: RoundKind, occurrence: number, total: number) {
  const base = ROUND_TITLES[kind];
  return total > 1 ? `${base} · part ${occurrence + 1}` : base;
}

export function titledPlan(plan: RoundKind[]) {
  return plan.map((kind, i) => {
    const occurrence = plan.slice(0, i).filter((k) => k === kind).length;
    const total = plan.filter((k) => k === kind).length;
    return { kind, title: roundTitle(kind, occurrence, total) };
  });
}

/** Keep only emoji (incl. ZWJ sequences, skin tones, flags) and single spaces. */
export function emojiOnly(s: string): string {
  const parts = s.match(
    /\p{Regional_Indicator}{2}|(?:\p{Extended_Pictographic}|[#*0-9]️?⃣)(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*| /gu,
  );
  return (parts ?? []).join("").replace(/ {2,}/g, " ").trim();
}

/** Parse pasted text (e.g. last retro's Markdown export) into action items. */
export function parsePreviousItems(text: string): string[] {
  let lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#+\s*action items/i.test(l.trim()));
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^#+\s/.test(l.trim()));
    lines = end >= 0 ? rest.slice(0, end) : rest;
  }
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^_.*_$/.test(l))
    .map((l) =>
      l
        .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s+/, "")
        .replace(/\s*\(idea: [^)]*\)\s*$/i, "") // our export: "(idea: Name)"
        .replace(/\s+—\s+owners?:.*$/i, "") // our export: "— owner: Name"
        .replace(/(\(\d+ votes?\))\s+—\s+[^—]*$/i, "$1") // v0.1 export: "(3 votes) — Name"
        .replace(/\s*\(\d+ votes?\)\s*$/i, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, MAX_PREVIOUS_ITEMS);
}
