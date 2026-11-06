// Shared protocol between the PartyKit server and the React clients.

export type RoundKind = "warmup" | "retro" | "lastlash";

export interface Settings {
  /** Hide who wrote what, and hide scores. Recommended for retros. */
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
}

export const DEFAULT_SETTINGS: Settings = {
  anonymous: false,
  rounds: ["warmup", "retro", "lastlash"],
  answerSeconds: 90,
  voteSeconds: 25,
  customPrompts: [],
  lashPrompt: "One concrete thing we should change next sprint",
  lashMaxAnswers: 2,
  lashVotes: 3,
};

export type Phase =
  | "lobby"
  | "roundIntro"
  | "answering"
  | "voting"
  | "matchupResult"
  | "roundResult"
  | "lashVoting"
  | "lashResult"
  | "summary";

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  connected: boolean;
  score: number;
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
  /** Points awarded per side, only in non-anonymous mode. */
  points?: [number, number];
  unanimous?: boolean;
}

export interface LashAnswerView {
  id: string;
  text: string;
  votes?: number;
  author?: string;
}

export interface SummaryRound {
  kind: RoundKind;
  title: string;
  matchups: MatchupView[];
  lashPrompt?: string;
  lashAnswers?: LashAnswerView[];
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
  /** Milliseconds left on the current timer at send time. */
  remainingMs: number | null;
  /** Player ids that have finished the current task (answering/voting). */
  doneIds: string[];
  /** Player ids expected to act in the current phase. */
  expectedIds: string[];
  matchup?: MatchupView;
  matchupNumber?: number;
  matchupCount?: number;
  lashPrompt?: string;
  lashAnswers?: LashAnswerView[];
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
  playerCount: number;
  minPlayers: number;
}

export type ServerMessage =
  | { t: "view"; view: HostView | PlayerView }
  | { t: "error"; message: string };

export type ClientMessage =
  | { t: "helloHost" }
  | { t: "helloPlayer"; name: string }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "start" }
  | { t: "next" }
  | { t: "kick"; playerId: string }
  | { t: "restart" }
  | { t: "answer"; matchupId: string; text: string }
  | { t: "lashAnswers"; texts: string[] }
  | { t: "vote"; matchupId: string; choice: 0 | 1 }
  | { t: "lashVote"; answerIds: string[] };

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 16;
export const MAX_ANSWER_LENGTH = 80;
export const MAX_LASH_LENGTH = 120;

export const ROUND_TITLES: Record<RoundKind, string> = {
  warmup: "Warm-up",
  retro: "The Sprint",
  lastlash: "Last Lash: Action Items",
};
