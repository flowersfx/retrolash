// Retrolash game room: the authoritative state machine for one game.
// It knows nothing about the transport. The runtime (server/main.ts) hands it a
// Room with connections and storage, and calls the on* hooks.
import {
  DEFAULT_SETTINGS,
  FOLLOWUP_OPTIONS,
  MAX_ANSWER_LENGTH,
  MAX_AUDIENCE,
  MAX_EMOJI_LENGTH,
  MAX_LASH_LENGTH,
  MAX_PLAYERS,
  MAX_PREVIOUS_ITEMS,
  MIN_PLAYERS,
  MOODS,
  REACTIONS,
  TOGGLEABLE_ROUNDS,
  emojiOnly,
  isHeadToHead,
  planRounds,
  titledPlan,
  type ClientMessage,
  type FollowupItemView,
  type HostView,
  type LashAnswerView,
  type MatchupView,
  type Phase,
  type PlayerView,
  type PublicPlayer,
  type RoundKind,
  type ServerMessage,
  type Settings,
  type SummaryRound,
} from "../shared/types";
import { EMOJI_PROMPTS, RETRO_PROMPTS, WARMUP_PROMPTS, shuffle } from "../shared/prompts";

// ---------- runtime contract ----------

export interface Connection {
  /** Stable per-device id (the client's PartySocket `id`). */
  readonly id: string;
  readonly state: unknown;
  setState(state: unknown): void;
  send(data: string): void;
}

export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface Room {
  /** Lowercase room code. */
  readonly id: string;
  readonly storage: RoomStorage;
  getConnections(): Iterable<Connection>;
}

// ---------- internal state ----------

interface Player extends PublicPlayer {}

interface Matchup {
  id: string;
  prompt: string;
  playerIds: [string, string];
  answers: [string | null, string | null];
  votes: Record<string, 0 | 1>;
  points?: [number, number];
  unanimous?: boolean;
  closed?: boolean;
}

interface LashAnswer {
  id: string;
  playerId: string;
  text: string;
  votes: number;
  /** Player ids who volunteered to own this action item. */
  owners?: string[];
}

interface Round {
  kind: RoundKind;
  title: string;
  /** Points multiplier for head-to-head and Last Lash rounds. */
  multiplier: number;
  matchups: Matchup[];
  lashPrompt?: string;
  lashAnswers: LashAnswer[];
  lashSubmitted: string[];
  lashBallots: Record<string, string[]>;
  /** Check-in: player id → MOODS index. */
  moods?: Record<string, number>;
  /** Follow-up: last retro's items, and each player's answers. */
  followupItems?: string[];
  followupBallots?: Record<string, (number | null)[]>;
}

interface GameState {
  phase: Phase;
  players: Player[];
  settings: Settings;
  /** The rounds this game plays, fixed at start. */
  plan: RoundKind[];
  rounds: Round[];
  roundIndex: number;
  matchupIndex: number;
  deadline: number | null;
  /** Remaining time while the facilitator holds the timer. */
  pausedMs: number | null;
  usedPrompts: string[];
}

type ConnState = { role: "host" } | { role: "player" } | undefined;

const AVATARS = [
  "🦊", "🐙", "🦉", "🐸", "🦄", "🐝", "🐳", "🦖", "🐧", "🦔", "🐢", "🦩",
  "🐼", "🦁", "🐌", "🦦", "🐨", "🦜", "🐞", "🦀",
];
const AUDIENCE_AVATARS = ["🍿", "🎩", "🕶️", "🧐", "🤠", "👽", "🤖", "🧙"];

const INTRO_MS = 5000;
const QUICK_RESULT_MS = 8000; // warm-up / emoji matchup results
const ROUND_RESULT_MS = 10000;
const CHECKIN_ANSWER_MS = 30000;
const FOLLOWUP_ANSWER_MS = 60000;
const CHECKIN_RESULT_MS = 12000;
const FOLLOWUP_RESULT_MIN_MS = 20000;
/** When all players are done but the audience isn't, give them this long. */
const AUDIENCE_GRACE_MS = 5000;
const REACTION_GAP_MS = 500;
const MAX_CLAIMABLE = 5;

function multiplier(kind: RoundKind, occurrence: number) {
  switch (kind) {
    case "warmup":
    case "emoji":
      return 1;
    case "retro":
      return occurrence === 0 ? 2 : 3;
    case "lastlash":
      return 3;
    default:
      return 0;
  }
}

function freshState(settings: Settings = DEFAULT_SETTINGS): GameState {
  return {
    phase: "lobby",
    players: [],
    settings,
    plan: [],
    rounds: [],
    roundIndex: 0,
    matchupIndex: 0,
    deadline: null,
    pausedMs: null,
    usedPrompts: [],
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";

export class GameRoom {
  state: GameState = freshState();
  timer: ReturnType<typeof setTimeout> | null = null;
  private lastReaction = new Map<string, number>();

  /** timeScale < 1 speeds every timer up (used by the end-to-end test). */
  constructor(
    readonly room: Room,
    private readonly timeScale = 1,
  ) {}

  /** Stop timers before the runtime drops this room from memory. */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async onStart() {
    const saved = await this.room.storage.get<GameState>("state");
    if (saved) {
      // Fill in fields that older saved games don't have.
      this.state = { ...freshState(), ...saved };
      this.state.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved.settings });
      // Nobody is connected right after a restart.
      this.state.players.forEach((p) => (p.connected = false));
      this.armTimer();
    }
  }

  // ---------- connection lifecycle ----------

  onConnect(conn: Connection) {
    // Role is set by the hello message; send nothing until then.
    void conn;
  }

  onClose(conn: Connection) {
    const st = conn.state as ConnState;
    if (st?.role === "player") {
      const stillOpen = [...this.room.getConnections()].some(
        (c) => c.id === conn.id && c !== conn,
      );
      const p = this.player(conn.id);
      if (p && !stillOpen) p.connected = false;
      this.checkAllDone();
      this.commit();
    }
  }

  onMessage(raw: string | ArrayBuffer | ArrayBufferView, conn: Connection) {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const role = (conn.state as ConnState)?.role;

    switch (msg.t) {
      case "helloHost":
        conn.setState({ role: "host" });
        this.sendView(conn);
        return;
      case "helloPlayer":
        return this.onPlayerHello(conn, msg.name, !!msg.audience);
      case "react":
        if (role === "player") this.onReaction(conn.id, msg.emoji);
        return;
    }

    if (role === "host") return this.onHostMessage(msg);
    if (role === "player") return this.onPlayerMessage(conn.id, msg);
  }

  // ---------- player join ----------

  onPlayerHello(conn: Connection, rawName: string, audience: boolean) {
    let p = this.player(conn.id);
    if (!p) {
      const name = clean(rawName, 16);
      if (!name) return this.error(conn, "Please enter a name.");
      if (audience) {
        if (this.state.players.filter((x) => x.audience).length >= MAX_AUDIENCE)
          return this.error(conn, "The audience is full.");
      } else if (this.state.players.filter((x) => !x.audience).length >= MAX_PLAYERS) {
        return this.error(conn, "This game is full. You can still join as audience.");
      }
      const avatar = audience ? this.audienceAvatar() : this.playerAvatar();
      let finalName = name;
      let n = 2;
      while (
        this.state.players.some((x) => x.name.toLowerCase() === finalName.toLowerCase())
      ) {
        finalName = `${name} ${n++}`;
      }
      p = { id: conn.id, name: finalName, avatar, connected: true, score: 0 };
      if (audience) p.audience = true;
      this.state.players.push(p);
    }
    p.connected = true;
    conn.setState({ role: "player" });
    this.commit();
  }

  playerAvatar() {
    const used = new Set(this.state.players.map((x) => x.avatar));
    return AVATARS.find((a) => !used.has(a)) ?? AVATARS[this.state.players.length % AVATARS.length];
  }

  audienceAvatar() {
    const n = this.state.players.filter((x) => x.audience).length;
    return AUDIENCE_AVATARS[n % AUDIENCE_AVATARS.length];
  }

  // ---------- reactions (big screen only, not persisted) ----------

  onReaction(playerId: string, emoji: unknown) {
    if (typeof emoji !== "string" || !REACTIONS.includes(emoji)) return;
    const p = this.player(playerId);
    if (!p) return;
    const now = Date.now();
    if (now - (this.lastReaction.get(playerId) ?? 0) < REACTION_GAP_MS) return;
    this.lastReaction.set(playerId, now);
    const msg: ServerMessage = {
      t: "reaction",
      emoji,
      ...(this.state.settings.anonymous ? {} : { avatar: p.avatar }),
    };
    const data = JSON.stringify(msg);
    for (const c of this.room.getConnections()) {
      if ((c.state as ConnState)?.role === "host") c.send(data);
    }
  }

  // ---------- host controls ----------

  onHostMessage(msg: ClientMessage) {
    const s = this.state;
    switch (msg.t) {
      case "settings": {
        if (s.phase !== "lobby") return;
        s.settings = sanitizeSettings({ ...s.settings, ...msg.settings });
        break;
      }
      case "kick": {
        const target = this.player(msg.playerId);
        if (!target) return;
        // Players can only be removed in the lobby; audience members any time.
        if (s.phase !== "lobby" && !target.audience) return;
        s.players = s.players.filter((p) => p.id !== msg.playerId);
        for (const c of this.room.getConnections()) {
          if (c.id === msg.playerId) {
            this.error(c, "You were removed from the room.");
            c.setState(undefined);
          }
        }
        this.checkAllDone();
        break;
      }
      case "start": {
        if (s.phase !== "lobby") return;
        const playing = this.connectedPlayers().length;
        if (playing < MIN_PLAYERS) return;
        const plan = planRounds(s.settings, playing);
        if (plan.length === 0) return;
        s.plan = plan;
        s.rounds = [];
        s.roundIndex = 0;
        s.usedPrompts = [];
        s.players.forEach((p) => (p.score = 0));
        this.startRound();
        break;
      }
      case "next":
        this.advance();
        break;
      case "hold":
        this.toggleHold();
        break;
      case "restart": {
        const players = s.players.map((p) => ({ ...p, score: 0 }));
        this.dispose();
        this.state = freshState(s.settings);
        this.state.players = players;
        break;
      }
      default:
        return;
    }
    this.commit();
  }

  toggleHold() {
    const s = this.state;
    if (s.pausedMs !== null) {
      s.deadline = Date.now() + s.pausedMs;
      s.pausedMs = null;
    } else if (s.deadline !== null) {
      s.pausedMs = Math.max(0, s.deadline - Date.now());
      s.deadline = null;
    }
    this.armTimer();
  }

  // ---------- player actions ----------

  onPlayerMessage(playerId: string, msg: ClientMessage) {
    const s = this.state;
    const round = this.round();
    const me = this.player(playerId);
    if (!me) return;
    const audience = !!me.audience;

    switch (msg.t) {
      case "answer": {
        if (s.phase !== "answering" || !round || !isHeadToHead(round.kind)) return;
        const m = round.matchups.find((x) => x.id === msg.matchupId);
        if (!m) return;
        const idx = m.playerIds.indexOf(playerId);
        if (idx < 0) return;
        const text =
          round.kind === "emoji"
            ? emojiOnly(clean(msg.text, MAX_EMOJI_LENGTH))
            : clean(msg.text, MAX_ANSWER_LENGTH);
        if (!text) return;
        m.answers[idx] = text;
        break;
      }
      case "lashAnswers": {
        if (audience || s.phase !== "answering" || round?.kind !== "lastlash") return;
        const texts = (Array.isArray(msg.texts) ? msg.texts : [])
          .map((t) => clean(t, MAX_LASH_LENGTH))
          .filter(Boolean)
          .slice(0, s.settings.lashMaxAnswers);
        if (texts.length === 0) return;
        round.lashAnswers = round.lashAnswers.filter((a) => a.playerId !== playerId);
        for (const text of texts)
          round.lashAnswers.push({ id: uid(), playerId, text, votes: 0 });
        if (!round.lashSubmitted.includes(playerId)) round.lashSubmitted.push(playerId);
        break;
      }
      case "mood": {
        if (audience || s.phase !== "answering" || round?.kind !== "checkin") return;
        const v = msg.value;
        if (!Number.isInteger(v) || v < 0 || v >= MOODS.length) return;
        (round.moods ??= {})[playerId] = v;
        break;
      }
      case "followup": {
        if (audience || s.phase !== "answering" || round?.kind !== "followup") return;
        const items = round.followupItems ?? [];
        const raw = Array.isArray(msg.answers) ? msg.answers : [];
        (round.followupBallots ??= {})[playerId] = items.map((_, i) => {
          const v = raw[i];
          return Number.isInteger(v) && v! >= 0 && v! < FOLLOWUP_OPTIONS.length ? v! : null;
        });
        break;
      }
      case "vote": {
        if (s.phase !== "voting" || !round) return;
        const m = round.matchups[s.matchupIndex];
        if (!m || m.id !== msg.matchupId) return;
        if (m.playerIds.includes(playerId)) return;
        if (msg.choice !== 0 && msg.choice !== 1) return;
        m.votes[playerId] = msg.choice;
        break;
      }
      case "lashVote": {
        if (s.phase !== "lashVoting" || !round) return;
        const allowed = new Set(
          round.lashAnswers.filter((a) => a.playerId !== playerId).map((a) => a.id),
        );
        const ids = [...new Set(Array.isArray(msg.answerIds) ? msg.answerIds : [])]
          .filter((id) => allowed.has(id))
          .slice(0, s.settings.lashVotes);
        round.lashBallots[playerId] = ids;
        break;
      }
      case "claim": {
        if (s.phase !== "lashResult" || round?.kind !== "lastlash") return;
        const a = claimableAnswers(round).find((x) => x.id === msg.answerId);
        if (!a) return;
        const owners = new Set(a.owners ?? []);
        if (msg.on) owners.add(playerId);
        else owners.delete(playerId);
        a.owners = [...owners];
        break;
      }
      default:
        return;
    }
    this.checkAllDone();
    this.commit();
  }

  // ---------- phase machine ----------

  startRound() {
    const s = this.state;
    const kind = s.plan[s.roundIndex];
    const occurrence = s.plan.slice(0, s.roundIndex).filter((k) => k === kind).length;
    s.rounds[s.roundIndex] = {
      kind,
      title: titledPlan(s.plan)[s.roundIndex].title,
      multiplier: multiplier(kind, occurrence),
      matchups: [],
      lashAnswers: [],
      lashSubmitted: [],
      lashBallots: {},
      lashPrompt: kind === "lastlash" ? s.settings.lashPrompt : undefined,
      ...(kind === "checkin" ? { moods: {} } : {}),
      ...(kind === "followup"
        ? { followupItems: [...s.settings.previousItems], followupBallots: {} }
        : {}),
    };
    s.matchupIndex = 0;
    this.setPhase("roundIntro", INTRO_MS);
  }

  beginAnswering() {
    const round = this.round()!;
    if (isHeadToHead(round.kind)) {
      const players = shuffle(this.connectedPlayers());
      // Head-to-head needs two people; skip the round if everyone else left.
      if (players.length < 2) return this.nextRound();
      const prompts = this.pickPrompts(round.kind, players.length);
      round.matchups = players.map((p, i) => ({
        id: uid(),
        prompt: prompts[i],
        playerIds: [p.id, players[(i + 1) % players.length].id],
        answers: [null, null],
        votes: {},
      }));
    }
    const ms =
      round.kind === "checkin"
        ? CHECKIN_ANSWER_MS
        : round.kind === "followup"
          ? FOLLOWUP_ANSWER_MS
          : this.state.settings.answerSeconds * 1000;
    this.setPhase("answering", ms);
  }

  endAnswering() {
    const round = this.round()!;
    if (round.kind === "checkin") return this.setPhase("pollResult", CHECKIN_RESULT_MS);
    if (round.kind === "followup") {
      const d = this.state.settings.discussionSeconds;
      return this.setPhase("pollResult", d === 0 ? null : Math.max(FOLLOWUP_RESULT_MIN_MS, d * 1000));
    }
    if (round.kind === "lastlash") {
      round.lashAnswers = shuffle(round.lashAnswers);
      if (round.lashAnswers.length === 0) return this.nextRound();
      this.setPhase("lashVoting", Math.max(45, this.state.settings.voteSeconds * 2) * 1000);
      return;
    }
    this.state.matchupIndex = 0;
    this.beginVoting();
  }

  beginVoting() {
    const s = this.state;
    const round = this.round()!;
    // Skip matchups where nobody answered.
    while (
      s.matchupIndex < round.matchups.length &&
      round.matchups[s.matchupIndex].answers.every((a) => a === null)
    ) {
      s.matchupIndex++;
    }
    if (s.matchupIndex >= round.matchups.length) return this.endRound();
    this.setPhase("voting", s.settings.voteSeconds * 1000);
    if (this.expectedIds().length === 0 && this.connectedAudience().length === 0) this.endVoting();
  }

  endVoting() {
    const round = this.round()!;
    const m = round.matchups[this.state.matchupIndex];
    const counts: [number, number] = [0, 0];
    Object.values(m.votes).forEach((v) => counts[v]++);
    const total = counts[0] + counts[1];
    const mult = round.multiplier;
    const points: [number, number] = [counts[0] * 100 * mult, counts[1] * 100 * mult];
    // An empty answer forfeits.
    if (m.answers[0] === null) points[0] = 0;
    if (m.answers[1] === null) points[1] = 0;
    if (counts[0] !== counts[1]) {
      const w = counts[0] > counts[1] ? 0 : 1;
      const unanimous = total >= 2 && counts[1 - w] === 0;
      m.unanimous = unanimous;
      points[w] += (unanimous ? 250 : 100) * mult;
    }
    m.points = points;
    m.closed = true;
    m.playerIds.forEach((id, i) => {
      const p = this.player(id);
      if (p) p.score += points[i];
    });
    // Sprint results pause for discussion (timed unless set to "wait for me").
    const d = this.state.settings.discussionSeconds;
    const ms = round.kind === "retro" ? (d === 0 ? null : d * 1000) : QUICK_RESULT_MS;
    this.setPhase("matchupResult", ms);
  }

  nextMatchup() {
    this.state.matchupIndex++;
    this.beginVoting();
  }

  endRound() {
    this.setPhase("roundResult", ROUND_RESULT_MS);
  }

  endLashVoting() {
    const round = this.round()!;
    round.lashAnswers.forEach((a) => (a.votes = 0));
    for (const ids of Object.values(round.lashBallots)) {
      for (const id of ids) {
        const a = round.lashAnswers.find((x) => x.id === id);
        if (a) a.votes++;
      }
    }
    for (const a of round.lashAnswers) {
      const p = this.player(a.playerId);
      if (p) p.score += a.votes * 100 * round.multiplier;
    }
    // The final part waits for the facilitator: people volunteer as owners here.
    this.setPhase("lashResult", null);
  }

  nextRound() {
    const s = this.state;
    s.roundIndex++;
    if (s.roundIndex >= s.plan.length) {
      this.setPhase("summary", null);
    } else {
      this.startRound();
    }
  }

  /** Host pressed "next", or a timer ran out. */
  advance() {
    switch (this.state.phase) {
      case "roundIntro":
        return this.beginAnswering();
      case "answering":
        return this.endAnswering();
      case "voting":
        return this.endVoting();
      case "matchupResult":
        return this.nextMatchup();
      case "roundResult":
      case "pollResult":
      case "lashResult":
        return this.nextRound();
      case "lashVoting":
        return this.endLashVoting();
    }
  }

  checkAllDone() {
    const s = this.state;
    if (!["answering", "voting", "lashVoting"].includes(s.phase)) return;
    const expected = this.expectedIds();
    if (expected.length === 0) return;
    const done = new Set(this.doneIds());
    if (!expected.every((id) => done.has(id))) return;
    // Everyone who must act has. Audience members who are still deciding get
    // a few more seconds instead of being cut off.
    if (s.phase !== "answering") {
      const waiting = this.connectedAudience().some((p) => !done.has(p.id));
      const left = s.deadline === null ? Infinity : s.deadline - Date.now();
      if (waiting && left > AUDIENCE_GRACE_MS * this.timeScale && s.pausedMs === null) {
        s.deadline = Date.now() + AUDIENCE_GRACE_MS * this.timeScale;
        this.armTimer();
        return;
      }
      if (waiting && left <= AUDIENCE_GRACE_MS * this.timeScale) return;
    }
    this.advance();
  }

  setPhase(phase: Phase, durationMs: number | null) {
    this.state.phase = phase;
    this.state.deadline = durationMs === null ? null : Date.now() + durationMs * this.timeScale;
    this.state.pausedMs = null;
    this.armTimer();
  }

  armTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const { deadline, phase } = this.state;
    if (deadline === null) return;
    this.timer = setTimeout(
      () => {
        if (this.state.phase === phase && this.state.deadline === deadline) {
          this.advance();
          this.commit();
        }
      },
      Math.max(0, deadline - Date.now()),
    );
  }

  // ---------- helpers ----------

  pickPrompts(kind: RoundKind, n: number): string[] {
    const s = this.state;
    const used = new Set(s.usedPrompts);
    const base =
      kind === "warmup" ? WARMUP_PROMPTS : kind === "emoji" ? EMOJI_PROMPTS : RETRO_PROMPTS;
    const custom =
      kind === "retro" ? s.settings.customPrompts.filter((p) => !used.has(p)) : [];
    let pool = [...custom, ...shuffle(base.filter((p) => !used.has(p)))];
    if (pool.length < n) pool = [...pool, ...shuffle(base)];
    const picked = pool.slice(0, n);
    s.usedPrompts.push(...picked);
    // Custom prompts come first in the pool but shouldn't all land on the
    // same players, so shuffle the final selection.
    return shuffle(picked);
  }

  round(): Round | undefined {
    return this.state.rounds[this.state.roundIndex];
  }

  player(id: string) {
    return this.state.players.find((p) => p.id === id);
  }

  /** Connected full players (not audience). */
  connectedPlayers() {
    return this.state.players.filter((p) => p.connected && !p.audience);
  }

  connectedAudience() {
    return this.state.players.filter((p) => p.connected && p.audience);
  }

  isConnected(id: string) {
    return !!this.player(id)?.connected;
  }

  expectedIds(): string[] {
    const s = this.state;
    const round = this.round();
    if (!round) return [];
    const everyone = () => this.connectedPlayers().map((p) => p.id);
    if (s.phase === "answering") {
      if (!isHeadToHead(round.kind)) return everyone();
      const ids = new Set(round.matchups.flatMap((m) => m.playerIds));
      return [...ids].filter((id) => this.isConnected(id));
    }
    if (s.phase === "voting") {
      const m = round.matchups[s.matchupIndex];
      return everyone().filter((id) => !m.playerIds.includes(id));
    }
    if (s.phase === "lashVoting") {
      // Players who only see their own answers have nothing to vote on.
      return everyone().filter((id) => round.lashAnswers.some((a) => a.playerId !== id));
    }
    return [];
  }

  doneIds(): string[] {
    const s = this.state;
    const round = this.round();
    if (!round) return [];
    if (s.phase === "answering") {
      if (round.kind === "lastlash") return [...round.lashSubmitted];
      if (round.kind === "checkin") return Object.keys(round.moods ?? {});
      if (round.kind === "followup") {
        return Object.entries(round.followupBallots ?? {})
          .filter(([, b]) => b.every((v) => v !== null))
          .map(([id]) => id);
      }
      const ids = new Set(round.matchups.flatMap((m) => m.playerIds));
      return [...ids].filter((id) =>
        round.matchups.every((m) => {
          const i = m.playerIds.indexOf(id);
          return i < 0 || m.answers[i] !== null;
        }),
      );
    }
    if (s.phase === "voting") return Object.keys(round.matchups[s.matchupIndex].votes);
    if (s.phase === "lashVoting") return Object.keys(round.lashBallots);
    return [];
  }

  name(id: string) {
    return this.player(id)?.name ?? "Someone";
  }

  matchupView(m: Matchup, reveal: boolean): MatchupView {
    const anon = this.state.settings.anonymous;
    const view: MatchupView = {
      id: m.id,
      prompt: m.prompt,
      answers: [m.answers[0] ?? "", m.answers[1] ?? ""],
    };
    if (reveal && m.closed) {
      const counts: [number, number] = [0, 0];
      const voters: [string[], string[]] = [[], []];
      const avatars: [string[], string[]] = [[], []];
      for (const [voter, v] of Object.entries(m.votes)) {
        counts[v]++;
        voters[v].push(this.name(voter));
        avatars[v].push(this.player(voter)?.avatar ?? "🙂");
      }
      view.votes = counts;
      view.unanimous = m.unanimous;
      if (!anon) {
        view.authors = [this.name(m.playerIds[0]), this.name(m.playerIds[1])];
        view.voterNames = voters;
        view.voterAvatars = avatars;
        view.points = m.points;
      }
    }
    return view;
  }

  lashView(round: Round, reveal: boolean): LashAnswerView[] {
    const anon = this.state.settings.anonymous;
    const list: LashAnswerView[] = round.lashAnswers.map((a) => ({
      id: a.id,
      text: a.text,
      ...(reveal ? { votes: a.votes } : {}),
      ...(reveal && !anon ? { author: this.name(a.playerId) } : {}),
      ...(reveal && a.owners?.length
        ? {
            owners: a.owners.map((id) => ({
              name: this.name(id),
              avatar: this.player(id)?.avatar ?? "🙂",
            })),
          }
        : {}),
    }));
    if (reveal) list.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
    return list;
  }

  moodCounts(round: Round): number[] {
    const counts = MOODS.map(() => 0);
    for (const v of Object.values(round.moods ?? {})) counts[v]++;
    return counts;
  }

  followupView(round: Round): FollowupItemView[] {
    return (round.followupItems ?? []).map((text, i) => {
      const counts = FOLLOWUP_OPTIONS.map(() => 0);
      for (const b of Object.values(round.followupBallots ?? {})) {
        const v = b[i];
        if (v !== null && v !== undefined) counts[v]++;
      }
      return { text, counts };
    });
  }

  summary(): SummaryRound[] {
    return this.state.rounds.map((r) => ({
      kind: r.kind,
      title: r.title,
      matchups: r.matchups.filter((m) => m.closed).map((m) => this.matchupView(m, true)),
      lashPrompt: r.lashPrompt,
      lashAnswers: r.kind === "lastlash" ? this.lashView(r, true) : undefined,
      moodCounts: r.kind === "checkin" ? this.moodCounts(r) : undefined,
      followupItems: r.kind === "followup" ? this.followupView(r) : undefined,
    }));
  }

  remainingMs() {
    const d = this.state.deadline;
    return d === null ? null : Math.max(0, d - Date.now());
  }

  publicPlayers(): PublicPlayer[] {
    const anon = this.state.settings.anonymous;
    return this.state.players.map((p) => ({ ...p, score: anon ? 0 : p.score }));
  }

  hostView(): HostView {
    const s = this.state;
    const round = this.round();
    const plan = s.phase === "lobby" ? planRounds(s.settings, this.connectedPlayers().length) : s.plan;
    const view: HostView = {
      role: "host",
      code: this.room.id.toUpperCase(),
      phase: s.phase,
      settings: s.settings,
      players: this.publicPlayers(),
      roundNumber: s.roundIndex + 1,
      roundCount: plan.length,
      roundKind: round?.kind,
      roundTitle: round?.title,
      plan: titledPlan(plan),
      remainingMs: this.remainingMs(),
      pausedMs: s.pausedMs,
      doneIds: this.doneIds(),
      expectedIds: this.expectedIds(),
    };
    if (round && (s.phase === "voting" || s.phase === "matchupResult")) {
      const m = round.matchups[s.matchupIndex];
      view.matchup = this.matchupView(m, s.phase === "matchupResult");
      view.matchupNumber = s.matchupIndex + 1;
      view.matchupCount = round.matchups.length;
    }
    if (round?.kind === "lastlash") {
      view.lashPrompt = round.lashPrompt;
      if (s.phase === "lashVoting") view.lashAnswers = this.lashView(round, false);
      if (s.phase === "lashResult") view.lashAnswers = this.lashView(round, true);
    }
    if (round && s.phase === "pollResult") {
      if (round.kind === "checkin") view.moodCounts = this.moodCounts(round);
      if (round.kind === "followup") view.followupItems = this.followupView(round);
    }
    if (round?.kind === "followup" && s.phase === "answering") {
      view.followupItems = (round.followupItems ?? []).map((text) => ({ text, counts: [] }));
    }
    if (s.phase === "summary") view.summary = this.summary();
    return view;
  }

  playerView(id: string): PlayerView {
    const s = this.state;
    const round = this.round();
    const me = this.player(id) ?? null;
    const view: PlayerView = {
      role: "player",
      code: this.room.id.toUpperCase(),
      phase: s.phase,
      you: me ? { ...me, score: s.settings.anonymous ? 0 : me.score } : null,
      anonymous: s.settings.anonymous,
      remainingMs: this.remainingMs(),
      roundKind: round?.kind,
      roundTitle: round?.title,
      playerCount: this.connectedPlayers().length,
      minPlayers: MIN_PLAYERS,
    };
    if (!round || !me) return view;

    if (s.phase === "answering" && !me.audience) {
      if (round.kind === "lastlash") {
        view.lashPrompt = round.lashPrompt;
        view.lashMaxAnswers = s.settings.lashMaxAnswers;
        view.myLashAnswers = round.lashAnswers.filter((a) => a.playerId === id).map((a) => a.text);
      } else if (round.kind === "checkin") {
        view.myMood = round.moods?.[id] ?? null;
      } else if (round.kind === "followup") {
        const items = round.followupItems ?? [];
        view.followup = {
          items,
          mine: round.followupBallots?.[id] ?? items.map(() => null),
        };
      } else {
        view.tasks = round.matchups
          .filter((m) => m.playerIds.includes(id))
          .map((m) => ({
            matchupId: m.id,
            prompt: m.prompt,
            answer: m.answers[m.playerIds.indexOf(id)],
          }));
      }
    }
    if (s.phase === "voting") {
      const m = round.matchups[s.matchupIndex];
      view.vote = {
        matchupId: m.id,
        prompt: m.prompt,
        answers: [m.answers[0] ?? "", m.answers[1] ?? ""],
        canVote: !m.playerIds.includes(id),
        myChoice: m.votes[id] ?? null,
      };
    }
    if (s.phase === "lashVoting") {
      const others = round.lashAnswers.filter((a) => a.playerId !== id);
      view.lashPrompt = round.lashPrompt;
      view.lashBallot = {
        answers: round.lashAnswers.map((a) => ({ id: a.id, text: a.text, mine: a.playerId === id })),
        votesAllowed: Math.min(s.settings.lashVotes, others.length),
        myVotes: round.lashBallots[id] ?? [],
        submitted: id in round.lashBallots,
      };
    }
    if (s.phase === "lashResult" && round.kind === "lastlash") {
      view.lashPrompt = round.lashPrompt;
      view.claimable = claimableAnswers(round).map((a) => ({
        id: a.id,
        text: a.text,
        votes: a.votes,
        owners: (a.owners ?? []).map((o) => this.name(o)),
        mine: (a.owners ?? []).includes(id),
      }));
    }
    return view;
  }

  sendView(conn: Connection) {
    const st = conn.state as ConnState;
    if (!st) return;
    const view = st.role === "host" ? this.hostView() : this.playerView(conn.id);
    const msg: ServerMessage = { t: "view", view };
    conn.send(JSON.stringify(msg));
  }

  error(conn: Connection, message: string) {
    const msg: ServerMessage = { t: "error", message };
    conn.send(JSON.stringify(msg));
  }

  /** Persist and push fresh views to everyone. */
  commit() {
    void this.room.storage.put("state", this.state);
    for (const c of this.room.getConnections()) this.sendView(c);
  }
}

/** The top-voted Last Lash answers, which people can volunteer to own. */
function claimableAnswers(round: Round): LashAnswer[] {
  const sorted = [...round.lashAnswers].sort((a, b) => b.votes - a.votes);
  const voted = sorted.filter((a) => a.votes > 0);
  return (voted.length ? voted : sorted).slice(0, MAX_CLAIMABLE);
}

function sanitizeSettings(s: Settings): Settings {
  const clamp = (n: unknown, lo: number, hi: number, d: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  const list = (v: unknown, max: number, len: number) =>
    (Array.isArray(v) ? v : [])
      .map((p) => clean(p, len))
      .filter(Boolean)
      .slice(0, max);
  const discussion = clamp(s.discussionSeconds, 0, 600, DEFAULT_SETTINGS.discussionSeconds);
  return {
    anonymous: !!s.anonymous,
    rounds: TOGGLEABLE_ROUNDS.filter((r) => (Array.isArray(s.rounds) ? s.rounds : []).includes(r)),
    answerSeconds: clamp(s.answerSeconds, 20, 300, DEFAULT_SETTINGS.answerSeconds),
    voteSeconds: clamp(s.voteSeconds, 10, 120, DEFAULT_SETTINGS.voteSeconds),
    customPrompts: list(s.customPrompts, 30, 120),
    lashPrompt: clean(s.lashPrompt, 120) || DEFAULT_SETTINGS.lashPrompt,
    lashMaxAnswers: clamp(s.lashMaxAnswers, 1, 3, DEFAULT_SETTINGS.lashMaxAnswers),
    lashVotes: clamp(s.lashVotes, 1, 5, DEFAULT_SETTINGS.lashVotes),
    sprintRounds: clamp(s.sprintRounds, 0, 3, DEFAULT_SETTINGS.sprintRounds),
    // Under 15 s is too short to talk; treat it as "wait for me" only when 0.
    discussionSeconds: discussion === 0 ? 0 : Math.max(15, discussion),
    previousItems: list(s.previousItems, MAX_PREVIOUS_ITEMS, MAX_LASH_LENGTH),
  };
}
