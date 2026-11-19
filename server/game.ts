// Retrolash game room: the authoritative state machine for one game.
// It knows nothing about the transport. The runtime (server/main.ts) hands it a
// Room with connections and storage, and calls the on* hooks.
import {
  AUDIENCE_AVATARS,
  AVATARS,
  DEFAULT_LASH_PROMPT,
  DEFAULT_SETTINGS,
  FOLLOWUP_OPTIONS,
  KUDOS_TEAM,
  LANGS,
  MAX_ANSWER_LENGTH,
  MAX_AUDIENCE,
  MAX_EMOJI_LENGTH,
  MAX_KUDOS_LENGTH,
  MAX_LASH_LENGTH,
  MAX_PLAYERS,
  MAX_PREVIOUS_ITEMS,
  MIN_PLAYERS,
  MOODS,
  NO_TALK,
  promptsEach,
  PACKS,
  PLATE_COLORS,
  REACTIONS,
  TOGGLEABLE_ROUNDS,
  HIGHLIGHT_STEP_MS,
  PODIUM_REVEAL,
  THEMES,
  TRIO_MIN_PLAYERS,
  emojiOnly,
  revealTiming,
  tally,
  winnerOf,
  isHeadToHead,
  planRounds,
  type ClientMessage,
  type FollowupItemView,
  type HighlightView,
  type HostView,
  type KudosView,
  type LashAnswerView,
  type MatchupView,
  type MyResult,
  type Phase,
  type PlayerView,
  type PublicPlayer,
  type RoundKind,
  type ServerMessage,
  type Settings,
  type SpokenClip,
  type Lang,
  type SummaryRound,
  type VoterView,
} from "../shared/types";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { roundTitle, spokenTitle, strings, titledPlan } from "../shared/i18n";
import { prompts, shuffle, sprintPrompts } from "../shared/prompts";

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

/** A line the big screen could say out loud. */
export interface SpeechLine {
  text: string;
  lang: Lang;
  /** lib: built-in text, cached for good. room: facilitator/player text, deleted with saved games. */
  scope: "lib" | "room";
}

export type SpeechClip = SpokenClip;

/** A line with an optional start time on the screen (ms after it appears).
 * Optional lines (the host's chatter) are dropped if their clip isn't ready; the rest must all be ready. */
export type TimedLine = SpeechLine & { at?: number; optional?: boolean };

/** Anonymous usage numbers: counts only, never names or answers. */
export type UsageEvent = Record<string, string | number | boolean>;

/** Text to speech (server/tts.ts). Optional: without it the game is silent. */
export interface SpeechOptions {
  /** One clip per slot (a player's answer to a matchup, their kudos): a newer line replaces an older one not made yet. */
  slot?: string;
  /** Room clips count against this game's character budget; past it they are not made. */
  budget?: { key: string; chars: number };
}

export interface Speech {
  readonly enabled: boolean;
  /** Start generating these in the background. */
  prefetch(lines: SpeechLine[], opts?: SpeechOptions): void;
  /** The clip if it is ready now, else null (and it gets queued). Never blocks. */
  get(line: SpeechLine, opts?: SpeechOptions): SpeechClip | null;
  /** Billable room characters spent under a budget key. */
  used?(key: string): number;
}

/** Room speech per game: a base plus a share per player, about 3× what a real game uses (see CLAUDE.md). */
export const SPEECH_BUDGET_BASE = 6000;
export const SPEECH_BUDGET_PER_PLAYER = 3000;

export interface Room {
  /** Lowercase room code. */
  readonly id: string;
  readonly storage: RoomStorage;
  getConnections(): Iterable<Connection>;
}

// ---------- internal state ----------

interface Player extends PublicPlayer {}

/** Two players head-to-head, or three in a three-way matchup. Arrays line up by side. */
interface Matchup {
  id: string;
  prompt: string;
  playerIds: string[];
  answers: (string | null)[];
  /** Voter id → side index. */
  votes: Record<string, number>;
  /** Voters who picked "neither". */
  skips?: string[];
  points?: number[];
  unanimous?: boolean;
  closed?: boolean;
  callout?: MatchupView["callout"];
  /** Sides the game answered because the timer ran out. */
  auto?: boolean[];
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
  /** Kudos: author id → recipient id (or KUDOS_TEAM) and message. */
  kudos?: Record<string, { to: string; text: string }>;
  /** Kudos authors in reveal order (shuffled, so order says nothing). */
  kudosOrder?: string[];
  /** When each kudos card lands on screen (ms), in step with the voice when it reads them. */
  kudosAt?: number[];
  /** Already held the reveal once to let the last clips finish. */
  kudosWaited?: boolean;
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
  /** Head-to-head wins in a row, per player. */
  streaks: Record<string, number>;
  /** Who led after the last round, and who just took over. */
  leaderId: string | null;
  leadChange: string | null;
  /** Clips for the current screen, fixed when the phase starts. */
  say: SpeechClip[] | null;
  /** SHA-256 of the big screen's secret; the first big screen gets the secret. */
  hostTokenHash?: string;
  startedAt?: number;
  /** Random id pairing a game's start and finish in the usage file (not the room code). */
  gameId?: string;
  /** Most extra screens watching at once during this game. */
  maxScreens?: number;
  /** Device id → player id, for someone who came back on another tab or browser. */
  aliases: Record<string, string>;
}

/** host: runs the game. screen: an extra big screen that only watches. player: a phone, acting as player `pid`. */
type ConnState = { role: "host" } | { role: "screen" } | { role: "player"; pid: string } | undefined;

const INTRO_MS = 5000;
const MATCHUP_INTRO_MS = 3600;
const QUICK_RESULT_MS = 9000; // warm-up / emoji matchup results
const ROUND_RESULT_MS = 10000;
const CHECKIN_ANSWER_MS = 30000;
const FOLLOWUP_ANSWER_MS = 60000;
const KUDOS_ANSWER_MS = 60000;
const CHECKIN_RESULT_MS = 12000;
const FOLLOWUP_RESULT_MIN_MS = 20000;
const PODIUM_MS = 15000;
/** When all players are done but the audience isn't, give them this long. */
const AUDIENCE_GRACE_MS = 5000;
/** Kudos cards: when the first lands, and the gap between them (longer when the voice reads them). */
const KUDOS_FIRST_MS = 700;
const KUDOS_FIRST_SPOKEN_MS = 2400;
const KUDOS_STEP_MS = 1800;
/** How long the end of the kudos round waits for the last notes' clips. */
const KUDOS_WAIT_MS = 3000;
/**
 * A player whose phone drops (screen off, app switch, reconnect, server restart)
 * is still waited for this long. Without it, a phone blinking offline for a
 * second while everyone else had answered ended the round early.
 */
const DROP_GRACE_MS = 45_000;
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
    streaks: {},
    leaderId: null,
    leadChange: null,
    say: null,
    aliases: {},
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";

export class GameRoom {
  state: GameState = freshState();
  timer: ReturnType<typeof setTimeout> | null = null;
  private lastReaction = new Map<string, number>();
  /** When each offline player dropped (in memory: a restart gives everyone a fresh grace). */
  private droppedAt = new Map<string, number>();
  private graceTimers = new Set<ReturnType<typeof setTimeout>>();

  /** timeScale < 1 speeds every timer up (used by the end-to-end test). */
  constructor(
    readonly room: Room,
    private readonly timeScale = 1,
    private readonly speech?: Speech,
    private readonly onUsage?: (e: UsageEvent) => void,
  ) {}

  /** Generate the lines every game uses, in both languages, once. */
  static warmSpeech(speech: Speech) {
    if (!speech.enabled) return;
    const lines: SpeechLine[] = [];
    for (const lang of LANGS) {
      const t = strings(lang);
      for (const text of [t.spoken.highlights, t.spoken.winnerIntro(false), t.spoken.winnerIntro(true), ...chatterLines(lang)])
        lines.push({ text, lang, scope: "lib" });
    }
    speech.prefetch(lines);
  }

  /** Stop timers before the runtime drops this room from memory. */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.graceTimers.forEach(clearTimeout);
    this.graceTimers.clear();
  }

  /** Start someone's grace period, and look again once it's over. */
  dropped(id: string) {
    this.droppedAt.set(id, Date.now());
    const t = setTimeout(() => {
      this.graceTimers.delete(t);
      this.checkAllDone();
      this.commit();
    }, DROP_GRACE_MS * this.timeScale + 50);
    this.graceTimers.add(t);
  }

  /** Connected, or dropped out only moments ago: still expected to answer and vote. */
  present(id: string) {
    const p = this.player(id);
    if (!p) return false;
    if (p.connected) return true;
    const at = this.droppedAt.get(id);
    return at !== undefined && Date.now() - at < DROP_GRACE_MS * this.timeScale;
  }

  async onStart() {
    const saved = await this.room.storage.get<GameState>("state");
    if (saved) {
      // Fill in fields that older saved games don't have.
      this.state = { ...freshState(), ...saved };
      this.state.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved.settings });
      this.state.aliases ??= {};
      // Games saved before v0.8.2 used the device id as the player id: keep those devices working.
      const aliased = new Set(Object.values(this.state.aliases));
      for (const p of this.state.players) if (!aliased.has(p.id)) this.state.aliases[p.id] = p.id;
      this.state.players.forEach((p, i) => {
        // Nobody is connected right after a restart, but everyone gets the grace period to come back.
        p.connected = false;
        p.color ??= PLATE_COLORS[i % PLATE_COLORS.length];
        if (!p.audience) this.dropped(p.id);
      });
      this.armTimer();
    }
  }

  /** Screen texts in the room's language. */
  t() {
    return strings(this.state.settings.lang);
  }

  // ---------- connection lifecycle ----------

  onConnect(conn: Connection) {
    // Role is set by the hello message; send nothing until then.
    void conn;
  }

  /** The player a phone connection acts as (its device id, unless it took over an earlier identity). */
  pidOf(conn: Connection): string | null {
    const st = conn.state as ConnState;
    return st?.role === "player" ? st.pid : null;
  }

  onClose(conn: Connection) {
    const pid = this.pidOf(conn);
    if (pid) {
      const stillOpen = [...this.room.getConnections()].some((c) => c !== conn && this.pidOf(c) === pid);
      const p = this.player(pid);
      if (p && !stillOpen) {
        p.connected = false;
        if (!p.audience) this.dropped(p.id);
      }
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
    const pid = this.pidOf(conn);

    switch (msg.t) {
      case "helloHost":
        return this.onHostHello(conn, msg.token);
      case "helloScreen":
        // Anyone with the room code may watch; a screen sends nothing else.
        conn.setState({ role: "screen" });
        if (this.state.phase !== "lobby")
          this.state.maxScreens = Math.max(this.state.maxScreens ?? 0, this.screenCount());
        return this.sendView(conn);
      case "helloPlayer":
        return this.onPlayerHello(conn, msg);
      case "react":
        if (pid) this.onReaction(pid, msg.emoji);
        return;
    }

    if (role === "host") return this.onHostMessage(msg);
    if (pid) return this.onPlayerMessage(pid, msg);
  }

  // ---------- big screen ----------

  /**
   * The first big screen of a room gets a secret token; after that, only a
   * screen that presents it may host. Without this, anyone who sees the room
   * code could open ?host=CODE and run the game.
   */
  onHostHello(conn: Connection, token: unknown) {
    const s = this.state;
    if (!s.hostTokenHash) {
      const fresh = randomBytes(24).toString("hex");
      s.hostTokenHash = hashToken(fresh);
      conn.setState({ role: "host" });
      const msg: ServerMessage = { t: "hostToken", token: fresh };
      conn.send(JSON.stringify(msg));
      this.commit();
      return;
    }
    const ok = typeof token === "string" && /^[a-f0-9]{48}$/.test(token) && sameHash(hashToken(token), s.hostTokenHash);
    if (!ok) return this.error(conn, this.t().errors.hostTaken);
    conn.setState({ role: "host" });
    this.sendView(conn);
  }

  // ---------- player join ----------

  onPlayerHello(conn: Connection, msg: Extract<ClientMessage, { t: "helloPlayer" }>) {
    const t = this.t();
    const s = this.state;
    // The device id is the phone's secret; the player id is public (views carry it).
    // Only the alias table links the two, so knowing a player id gets you nowhere.
    const known = Object.prototype.hasOwnProperty.call(s.aliases, conn.id) ? s.aliases[conn.id] : undefined;
    let p = known ? this.player(known) : undefined;
    const audience = !!msg.audience;
    const name = clean(msg.name, 16);
    if (!p && name) {
      // Same name and role, and nobody is on it: that's the same person on a new
      // tab or browser (a phone that slept, a re-scanned QR code). Pick up where
      // they left off instead of making "Name 2".
      const mine = s.players.find(
        (x) => !x.connected && !!x.audience === audience && x.name.toLowerCase() === name.toLowerCase(),
      );
      if (mine) {
        p = mine;
        s.aliases[conn.id] = mine.id;
      }
    }
    if (!p) {
      if (!name) return this.error(conn, t.errors.name);
      delete s.aliases[conn.id];
      if (audience) {
        if (this.state.players.filter((x) => x.audience).length >= MAX_AUDIENCE)
          return this.error(conn, t.errors.audienceFull);
      } else if (this.state.players.filter((x) => !x.audience).length >= MAX_PLAYERS) {
        return this.error(conn, t.errors.gameFull);
      }
      let finalName = name;
      let n = 2;
      while (
        this.state.players.some((x) => x.name.toLowerCase() === finalName.toLowerCase())
      ) {
        finalName = `${name} ${n++}`;
      }
      let id = randomBytes(8).toString("hex");
      while (this.player(id)) id = randomBytes(8).toString("hex");
      s.aliases[conn.id] = id;
      p = {
        id,
        name: finalName,
        avatar: this.chooseAvatar(msg.avatar, audience, id),
        color: this.chooseColor(msg.color),
        connected: true,
        score: 0,
      };
      if (audience) p.audience = true;
      this.state.players.push(p);
    }
    p.connected = true;
    this.droppedAt.delete(p.id);
    conn.setState({ role: "player", pid: p.id });
    this.commit();
  }

  /** The wanted avatar if it's valid and free, otherwise a free one. */
  chooseAvatar(wanted: unknown, audience: boolean, selfId: string) {
    const valid =
      typeof wanted === "string" && (AVATARS.includes(wanted) || AUDIENCE_AVATARS.includes(wanted));
    if (audience) return valid ? (wanted as string) : this.audienceAvatar();
    const taken = new Set(
      this.state.players.filter((x) => !x.audience && x.id !== selfId).map((x) => x.avatar),
    );
    if (valid && !taken.has(wanted as string)) return wanted as string;
    return AVATARS.find((a) => !taken.has(a)) ?? AVATARS[this.state.players.length % AVATARS.length];
  }

  /** The wanted plate colour if valid, otherwise the least-used one. */
  chooseColor(wanted: unknown) {
    if (typeof wanted === "string" && PLATE_COLORS.includes(wanted)) return wanted;
    const uses = (c: string) => this.state.players.filter((p) => p.color === c).length;
    return [...PLATE_COLORS].sort((a, b) => uses(a) - uses(b))[0];
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
      ...(this.state.settings.anonymous ? {} : { avatar: p.avatar, from: p.id }),
    };
    const data = JSON.stringify(msg);
    for (const c of this.room.getConnections()) {
      const role = (c.state as ConnState)?.role;
      if (role === "host" || role === "screen") c.send(data);
    }
  }

  // ---------- host controls (also VIP phones, for start/next/hold) ----------

  onHostMessage(msg: ClientMessage) {
    const s = this.state;
    switch (msg.t) {
      case "settings": {
        if (s.phase !== "lobby") return;
        const prev = s.settings;
        const next = { ...prev, ...msg.settings };
        // Switching language swaps the final prompt too, unless it was customised.
        if (
          msg.settings.lang &&
          msg.settings.lang !== prev.lang &&
          msg.settings.lashPrompt === undefined &&
          prev.lashPrompt === DEFAULT_LASH_PROMPT[prev.lang]
        ) {
          next.lashPrompt = DEFAULT_LASH_PROMPT[msg.settings.lang] ?? prev.lashPrompt;
        }
        s.settings = sanitizeSettings(next);
        break;
      }
      case "kick": {
        const target = this.player(msg.playerId);
        if (!target) return;
        // Players can only be removed in the lobby; audience members any time.
        if (s.phase !== "lobby" && !target.audience) return;
        s.players = s.players.filter((p) => p.id !== msg.playerId);
        for (const [device, pid] of Object.entries(s.aliases)) if (pid === msg.playerId) delete s.aliases[device];
        for (const c of this.room.getConnections()) {
          if (this.pidOf(c) === msg.playerId) {
            this.error(c, this.t().errors.kicked);
            c.setState(undefined);
          }
        }
        this.checkAllDone();
        break;
      }
      case "vip": {
        const target = this.player(msg.playerId);
        if (!target) return;
        if (msg.on) target.vip = true;
        else delete target.vip;
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
        s.streaks = {};
        s.leaderId = null;
        s.leadChange = null;
        s.players.forEach((p) => (p.score = 0));
        s.startedAt = Date.now();
        s.gameId = randomBytes(6).toString("hex");
        s.maxScreens = this.screenCount();
        this.prefetchLobby();
        this.startRound();
        this.usage("start");
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
        this.state.hostTokenHash = s.hostTokenHash;
        this.state.aliases = s.aliases;
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

    // A VIP phone is a remote control for the big screen.
    if (me.vip && (msg.t === "start" || msg.t === "next" || msg.t === "hold")) {
      return this.onHostMessage(msg);
    }

    switch (msg.t) {
      case "leave": {
        // Only in the lobby: mid-game the matchups count on everyone.
        if (s.phase !== "lobby") return;
        s.players = s.players.filter((p) => p.id !== playerId);
        for (const [device, pid] of Object.entries(s.aliases)) if (pid === playerId) delete s.aliases[device];
        this.droppedAt.delete(playerId);
        const note = JSON.stringify({ t: "left", name: me.name } satisfies ServerMessage);
        for (const c of this.room.getConnections()) {
          const role = (c.state as ConnState)?.role;
          if (role === "host" || role === "screen") c.send(note);
          if (this.pidOf(c) === playerId) c.setState(undefined);
        }
        break;
      }
      case "profile": {
        me.avatar = this.chooseAvatar(msg.avatar, audience, playerId);
        me.color = this.chooseColor(msg.color);
        break;
      }
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
        // Start making the clip now, so it's ready when this matchup is voted on.
        if (round.kind !== "emoji") this.prefetchSpeech([text], `${this.room.id}:${m.id}:${playerId}`);
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
      case "kudos": {
        if (audience || s.phase !== "answering" || round?.kind !== "kudos") return;
        const to =
          msg.to === KUDOS_TEAM
            ? KUDOS_TEAM
            : typeof msg.to === "string" && msg.to !== playerId && this.player(msg.to)
              ? msg.to
              : null;
        const text = clean(msg.text, MAX_KUDOS_LENGTH);
        if (!to || !text) return;
        (round.kudos ??= {})[playerId] = { to, text };
        this.prefetchSpeech([this.kudosLine({ to, text })], `${this.room.id}:${s.gameId}:kudos:${playerId}`);
        break;
      }
      case "vote": {
        if (s.phase !== "voting" || !round) return;
        const m = round.matchups[s.matchupIndex];
        if (!m || m.id !== msg.matchupId) return;
        if (m.playerIds.includes(playerId)) return;
        const skips = new Set(m.skips ?? []);
        if (msg.choice === null) {
          // "Neither": counts as voted, nobody gets the point.
          delete m.votes[playerId];
          skips.add(playerId);
        } else {
          const c = msg.choice;
          if (!Number.isInteger(c) || c < 0 || c >= m.answers.length || m.answers[c] === null) return;
          m.votes[playerId] = c;
          skips.delete(playerId);
        }
        m.skips = [...skips];
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
      title: titledPlan(s.plan, s.settings.lang)[s.roundIndex].title,
      multiplier: multiplier(kind, occurrence),
      matchups: [],
      lashAnswers: [],
      lashSubmitted: [],
      lashBallots: {},
      lashPrompt: kind === "lastlash" ? s.settings.lashPrompt : undefined,
      ...(kind === "checkin" ? { moods: {} } : {}),
      ...(kind === "kudos" ? { kudos: {} } : {}),
      ...(kind === "followup"
        ? { followupItems: [...s.settings.previousItems], followupBallots: {} }
        : {}),
    };
    s.matchupIndex = 0;
    const t = this.t();
    const intro = t.spoken.round(s.roundIndex + 1, spokenTitle(s.rounds[s.roundIndex].title));
    const welcome = s.roundIndex === 0 ? [this.chatter(t.spoken.welcome)] : [];
    this.spokenPhase("roundIntro", INTRO_MS, [...welcome, this.line(intro, "lib")], 1500);
  }

  beginAnswering() {
    const round = this.round()!;
    if (isHeadToHead(round.kind)) {
      // Someone reconnecting right now (a phone waking up) still gets prompts.
      const players = shuffle(this.state.players.filter((p) => !p.audience && this.present(p.id)));
      // Head-to-head needs two people; skip the round if everyone else left.
      if (players.length < 2) return this.nextRound();
      const groups = groupPlayers(
        players.map((p) => p.id),
        this.state.settings.trios && players.length >= TRIO_MIN_PLAYERS,
        promptsEach(this.state.settings, players.length),
      );
      const prompts = this.pickPrompts(round.kind, groups.length);
      round.matchups = groups.map((ids, i) => ({
        id: uid(),
        prompt: prompts[i],
        playerIds: ids,
        answers: ids.map(() => null),
        votes: {},
      }));
      // Audio for every prompt is made while people write (~90 s), well before each intro.
      this.speech?.prefetch(round.matchups.map((m) => this.line(m.prompt)), this.speechOpts());
    }
    const ms =
      round.kind === "checkin"
        ? CHECKIN_ANSWER_MS
        : round.kind === "followup"
          ? FOLLOWUP_ANSWER_MS
          : round.kind === "kudos"
            ? KUDOS_ANSWER_MS
            : this.state.settings.answerSeconds * 1000;
    const write = this.t().spoken.write;
    if (round.kind === "lastlash")
      return this.spokenPhase("answering", ms, [this.chatter(write.lastlash), this.line(round.lashPrompt ?? "")], 0);
    const kind = round.kind === "retro" || round.kind === "warmup" ? "h2h" : round.kind;
    this.spokenPhase("answering", ms, [this.chatter(write[kind])], 0);
  }

  endAnswering() {
    const round = this.round()!;
    const say = this.t().spoken;
    if (round.kind === "checkin") return this.spokenPhase("pollResult", CHECKIN_RESULT_MS, [this.chatter(say.poll.checkin)], 0);
    if (round.kind === "followup") {
      const d = this.state.settings.discussionSeconds;
      const ms = d === 0 ? null : Math.max(FOLLOWUP_RESULT_MIN_MS, d * 1000);
      return this.spokenPhase("pollResult", ms, [this.chatter(say.poll.followup)], 0);
    }
    if (round.kind === "kudos") {
      const order = shuffle(Object.keys(round.kudos ?? {}));
      if (order.length === 0) return this.nextRound();
      round.kudosOrder = order;
      // Read every note as its card lands, if all the clips are ready (all or none:
      // nobody's thanks gets skipped). Otherwise the cards land on the usual beat.
      const notes = order.map((id) => ({ ...this.line(this.kudosLine(round.kudos![id])), optional: false }));
      const clips = this.speech?.enabled && this.state.settings.speech ? notes.map((l) => this.speech!.get(l, this.speechOpts())) : [];
      const voiced = clips.length > 0 && clips.every((c) => c);
      // The last note was probably sent a moment ago: give its clip a few seconds once.
      if (clips.length > 0 && !voiced && !round.kudosWaited) {
        round.kudosWaited = true;
        this.state.deadline = Date.now() + KUDOS_WAIT_MS * this.timeScale;
        this.armTimer();
        return;
      }
      const at: number[] = [];
      let cursor = voiced ? KUDOS_FIRST_SPOKEN_MS : KUDOS_FIRST_MS;
      order.forEach((_, i) => {
        at.push(cursor);
        cursor += voiced ? Math.max(KUDOS_STEP_MS, clips[i]!.ms + 600) : KUDOS_STEP_MS;
      });
      round.kudosAt = at;
      const lines: TimedLine[] = [
        this.chatter(say.poll.kudos),
        ...(voiced ? notes.map((l, i) => ({ ...l, at: at[i] })) : []),
      ];
      const ms = Math.min(60000, Math.max(12000, 4000 + order.length * 3500));
      return this.spokenPhase("pollResult", ms, lines, 2500);
    }
    if (round.kind === "lastlash") {
      round.lashAnswers = shuffle(round.lashAnswers);
      if (round.lashAnswers.length === 0) return this.nextRound();
      const ms = Math.max(45, this.state.settings.voteSeconds * 2) * 1000;
      return this.spokenPhase("lashVoting", ms, [this.chatter(say.lashVote)], 0);
    }
    this.fillMissing(round);
    if (round.kind !== "emoji") this.prefetchSpeech(round.matchups.flatMap((m) => m.answers.filter((a): a is string => !!a)));
    this.state.matchupIndex = 0;
    this.beginVoting();
  }

  /** Quiplash-style: a player who ran out of time gets a 🆘 answer, so nobody wins by walkover. */
  fillMissing(round: Round) {
    const set = prompts(this.state.settings.lang);
    const pool = round.kind === "emoji" ? set.safetyEmoji : set.safetyQuips;
    for (const m of round.matchups) {
      const missing = m.answers.flatMap((a, i) => (a === null ? [i] : []));
      // Nobody answered: the matchup is skipped.
      if (missing.length === 0 || missing.length === m.answers.length) continue;
      for (const i of missing) {
        const options = pool.filter((q) => !m.answers.includes(q));
        m.answers[i] = options[Math.floor(Math.random() * options.length)] ?? pool[0];
      }
      m.auto = m.answers.map((_, i) => missing.includes(i));
    }
  }

  /** Find the next matchup worth playing and announce it. */
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
    // To read answers aloud later: prefetch them in endAnswering, and give the
    // voting phase its own spokenPhase with the two answers.
    this.spokenPhase("matchupIntro", MATCHUP_INTRO_MS, [this.line(round.matchups[s.matchupIndex].prompt)], 1000);
  }

  startVoting() {
    const s = this.state;
    const round = this.round()!;
    // The first vote of a round gets a nudge; after that the prompt speaks for itself.
    const first = round.matchups.slice(0, s.matchupIndex).every((m) => !m.closed);
    const lines = first ? [this.chatter(this.t().spoken.vote)] : [];
    this.spokenPhase("voting", s.settings.voteSeconds * 1000, [...lines, ...this.answerLines(round)], 0);
    if (this.expectedIds().length === 0 && this.connectedAudience().length === 0) this.endVoting();
  }

  endVoting() {
    const s = this.state;
    const round = this.round()!;
    const m = round.matchups[s.matchupIndex];
    const counts = tally(m.votes, m.answers.length);
    const total = counts.reduce((a, b) => a + b, 0);
    const mult = round.multiplier;
    const auto = m.auto ?? m.answers.map(() => false);
    const points = counts.map((c) => c * 100 * mult);
    // An empty answer forfeits; an automatic one earns half its vote points and no win bonus.
    m.answers.forEach((a, i) => {
      if (a === null) points[i] = 0;
      else if (auto[i]) points[i] = Math.floor(points[i] / 2);
    });
    const winner = winnerOf(counts);
    if (winner !== null) {
      // A clean sweep: every vote went to one answer.
      const unanimous = total >= 2 && counts[winner] === total;
      m.unanimous = unanimous;
      if (!auto[winner]) points[winner] += (unanimous ? 250 : 100) * mult;
    }
    const before = new Map(s.players.map((p) => [p.id, p.score]));
    m.points = points;
    m.closed = true;
    m.playerIds.forEach((id, i) => {
      const p = this.player(id);
      if (p) p.score += points[i];
      s.streaks[id] = winner === i && !auto[i] ? (s.streaks[id] ?? 0) + 1 : 0;
    });
    m.callout = this.callout(m, winner, before);
    this.prefetchWinner();
    // Sprint results pause for discussion (timed unless set to "wait for me"; "0 s" is just the short cooldown).
    const d = s.settings.discussionSeconds;
    const ms = round.kind !== "retro" || d === NO_TALK ? QUICK_RESULT_MS : d === 0 ? null : d * 1000;
    this.spokenPhase("matchupResult", ms, this.resultLines(m, counts, winner), 600);
  }

  /**
   * The answers, read out once the cards have flown in. All or nothing: if one
   * clip isn't ready, none are read, so no answer gets an unfair advantage.
   * Emoji answers aren't read (the voice would spell out emoji names).
   */
  answerLines(round: Round): TimedLine[] {
    const m = round.matchups[this.state.matchupIndex];
    if (!m || round.kind === "emoji" || !this.speech?.enabled || !this.state.settings.speech) return [];
    const lines: TimedLine[] = m.answers
      .filter((a): a is string => !!a)
      .map((a, i) => ({ ...this.line(a), ...(i === 0 ? { at: 1300 } : {}) }));
    return lines.every((l) => this.speech!.get(l, this.speechOpts())) ? lines : [];
  }

  /** A kudos note as the voice says it: "For Ada: thanks for the reviews". */
  kudosLine(k: { to: string; text: string }) {
    const to = k.to === KUDOS_TEAM ? null : this.name(k.to);
    return this.t().spoken.kudos(to, k.text);
  }

  /** Queue player text for speech (when the room has speech on). */
  prefetchSpeech(texts: string[], slot?: string) {
    if (!this.speech?.enabled || !this.state.settings.speech) return;
    this.speech.prefetch(texts.map((t) => this.line(t)), { ...this.speechOpts(), slot });
  }

  /** This game's speech budget: room clips stop once it's spent (the game just goes quiet). */
  speechOpts(): SpeechOptions {
    const s = this.state;
    const players = s.players.filter((p) => !p.audience).length;
    return {
      budget: {
        key: `${this.room.id}:${s.gameId ?? "lobby"}`,
        chars: SPEECH_BUDGET_BASE + SPEECH_BUDGET_PER_PLAYER * players,
      },
    };
  }

  /** A word from the host as the result lands on screen. */
  resultLines(m: Matchup, counts: number[], winner: number | null): TimedLine[] {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    const r = this.t().spoken.result;
    const [top, second] = [...counts].sort((a, b) => b - a);
    const list = m.unanimous ? r.unanimous : winner === null ? r.tie : top - second === 1 ? r.close : r.blowout;
    return [{ ...this.chatter(list), at: revealTiming(total).result + (m.unanimous ? 500 : 150) }];
  }

  /** A hat trick (3+ wins in a row) or a climb out of last place. */
  callout(m: Matchup, winner: number | null, before: Map<string, number>): MatchupView["callout"] {
    if (winner === null || this.state.settings.anonymous || m.auto?.[winner]) return undefined;
    const id = m.playerIds[winner];
    const p = this.player(id);
    if (!p) return undefined;
    const n = this.state.streaks[id] ?? 0;
    if (n >= 3) return { kind: "streak", name: p.name, n };
    const others = this.state.players.filter((x) => !x.audience && x.id !== id);
    if (others.length >= 2) {
      const mine = before.get(id) ?? 0;
      const wasLast = others.every((x) => (before.get(x.id) ?? 0) > mine);
      const nowNotLast = others.some((x) => x.score < p.score);
      if (wasLast && nowNotLast) return { kind: "comeback", name: p.name };
    }
    return undefined;
  }

  nextMatchup() {
    this.state.matchupIndex++;
    this.beginVoting();
  }

  endRound() {
    const s = this.state;
    s.leadChange = null;
    if (!s.settings.anonymous) {
      const ranked = this.ranked();
      const top = ranked[0];
      if (top && top.score > 0 && (ranked.length < 2 || ranked[1].score < top.score)) {
        if (s.leaderId && s.leaderId !== top.id) s.leadChange = top.name;
        s.leaderId = top.id;
      }
    }
    this.spokenPhase("roundResult", ROUND_RESULT_MS, [{ ...this.chatter(this.t().spoken.roundDone), at: 700 }], 0);
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
    this.prefetchWinner();
    // The final part waits for the facilitator: people volunteer as owners here.
    const at = 1300 + round.lashAnswers.length * 450 + 500; // once the ranking has landed
    this.spokenPhase("lashResult", null, [{ ...this.chatter(this.t().spoken.lashResult), at }], 0);
  }

  nextRound() {
    const s = this.state;
    s.roundIndex++;
    if (s.roundIndex >= s.plan.length) this.endGame();
    else this.startRound();
  }

  /** After the last round: the best answers, then the podium, then the summary. */
  endGame() {
    const best = this.highlights();
    if (best.length === 0) return this.afterHighlights();
    const ms = 4500 + best.length * HIGHLIGHT_STEP_MS;
    this.spokenPhase("highlights", ms, [this.line(this.t().spoken.highlights, "lib")], 0);
  }

  afterHighlights() {
    const s = this.state;
    // Crown the winners first, unless there's nothing to crown.
    const scored = !s.settings.anonymous && s.players.some((p) => !p.audience && p.score > 0);
    if (!scored) return this.toSummary();
    this.spokenPhase("podium", PODIUM_MS, this.winnerLines(), 1500);
  }

  toSummary() {
    this.spokenPhase("summary", null, [{ ...this.chatter(this.t().spoken.wrap), at: 600 }], 0);
    this.usage("game");
  }

  /** "And the winner is…" during the drumroll, then the name(s) as first place appears. */
  winnerLines(): TimedLine[] {
    const ranked = this.ranked();
    const best = ranked[0]?.score ?? 0;
    const top = ranked.filter((p) => p.score === best && p.score > 0);
    if (top.length === 0) return [];
    const t = this.t();
    return [
      { ...this.line(t.spoken.winnerIntro(top.length > 1), "lib"), at: PODIUM_REVEAL.intro },
      { ...this.line(t.spoken.winners(top.map((p) => p.name)), "room"), at: PODIUM_REVEAL.first },
    ];
  }

  /** Keep the current leader's name ready, so the podium can say it. */
  prefetchWinner() {
    if (!this.speech?.enabled || !this.state.settings.speech || this.state.settings.anonymous) return;
    this.speech.prefetch(this.winnerLines(), this.speechOpts());
  }

  /** In the lobby, prepare the lines the planned game will say. */
  prefetchLobby() {
    const s = this.state;
    if (!this.speech?.enabled || !s.settings.speech) return;
    const t = this.t();
    const plan = titledPlan(this.currentPlan(), s.settings.lang);
    this.speech.prefetch([
      ...plan.map((r, i) => this.line(t.spoken.round(i + 1, spokenTitle(r.title)), "lib")),
      this.line(s.settings.lashPrompt),
      this.line(t.spoken.highlights, "lib"),
    ], this.speechOpts());
  }

  /** The game's best answers: clean sweeps first, then the most votes. Auto-answers don't count. */
  highlights(): HighlightView[] {
    const anon = this.state.settings.anonymous;
    const picks: { h: HighlightView; rank: number }[] = [];
    for (const r of this.state.rounds) {
      if (!isHeadToHead(r.kind)) continue;
      for (const m of r.matchups) {
        if (!m.closed) continue;
        const counts = tally(m.votes, m.answers.length);
        const w = winnerOf(counts);
        if (w === null) continue;
        const answer = m.answers[w];
        if (answer === null || m.auto?.[w]) continue;
        const total = counts.reduce((a, b) => a + b, 0);
        const h: HighlightView = {
          prompt: m.prompt,
          answer,
          votes: counts[w],
          total,
          unanimous: !!m.unanimous,
          round: r.title,
          emoji: r.kind === "emoji",
          ...(anon ? {} : { author: this.player(m.playerIds[w]) ? this.plate(m.playerIds[w]) : null }),
        };
        picks.push({ h, rank: (m.unanimous ? 10_000 : 0) + counts[w] * 100 + total });
      }
    }
    return picks
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 3)
      .map((p) => p.h);
  }

  /** One line per game start and finish, with counts only. */
  usage(event: "start" | "game") {
    if (!this.onUsage) return;
    const s = this.state;
    const players = s.players.filter((p) => !p.audience).length;
    const botIds = new Set(Object.entries(s.aliases).filter(([device]) => device.startsWith("bot-")).map(([, pid]) => pid));
    const base: UsageEvent = {
      event,
      at: new Date().toISOString(),
      ...(s.gameId ? { game: s.gameId } : {}),
      players,
      audience: s.players.length - players,
      // Test bots (scripts/bots.mjs) have device ids starting with "bot-": summaries leave those games out.
      bots: s.players.filter((p) => botIds.has(p.id)).length,
      // Billable characters of this game's own clips (player and facilitator text), to tune the budget.
      speechChars: this.speech?.used?.(this.speechOpts().budget!.key) ?? 0,
      rounds: s.plan.length,
      lang: s.settings.lang,
      pack: s.settings.pack,
      speech: !!this.speech?.enabled && s.settings.speech,
      anonymous: s.settings.anonymous,
      trios: s.settings.trios,
      promptsEach: s.settings.promptsEach,
    };
    if (event === "start") return this.onUsage(base);
    const matchups = s.rounds.flatMap((r) => r.matchups.filter((m) => m.closed));
    const lash = s.rounds.find((r) => r.kind === "lastlash");
    this.onUsage({
      ...base,
      minutes: s.startedAt ? Math.round((Date.now() - s.startedAt) / 6000) / 10 : 0,
      active: this.activePlayers(),
      matchups: matchups.length,
      autoAnswers: matchups.reduce((a, m) => a + (m.auto?.filter(Boolean).length ?? 0), 0),
      kudos: Object.keys(s.rounds.find((r) => r.kind === "kudos")?.kudos ?? {}).length,
      actionItems: lash?.lashAnswers.length ?? 0,
      owned: lash?.lashAnswers.filter((a) => a.owners?.length).length ?? 0,
      screens: s.maxScreens ?? 0,
      vip: s.players.some((p) => p.vip),
    });
  }

  /** Players (not audience) who actually took part: wrote, voted, checked in or sent kudos. */
  activePlayers() {
    const ids = new Set<string>();
    for (const r of this.state.rounds) {
      for (const m of r.matchups) {
        m.playerIds.forEach((id, i) => m.answers[i] !== null && !m.auto?.[i] && ids.add(id));
        Object.keys(m.votes).forEach((id) => ids.add(id));
        (m.skips ?? []).forEach((id) => ids.add(id));
      }
      Object.keys(r.moods ?? {}).forEach((id) => ids.add(id));
      Object.keys(r.kudos ?? {}).forEach((id) => ids.add(id));
      Object.keys(r.followupBallots ?? {}).forEach((id) => ids.add(id));
      Object.keys(r.lashBallots).forEach((id) => ids.add(id));
      r.lashAnswers.forEach((a) => ids.add(a.playerId));
    }
    return this.state.players.filter((p) => !p.audience && ids.has(p.id)).length;
  }

  /** Extra screens connected right now. */
  screenCount() {
    return [...this.room.getConnections()].filter((c) => (c.state as ConnState)?.role === "screen").length;
  }

  /** Host pressed "next", or a timer ran out. */
  advance() {
    switch (this.state.phase) {
      case "roundIntro":
        return this.beginAnswering();
      case "answering":
        return this.endAnswering();
      case "matchupIntro":
        return this.startVoting();
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
      case "highlights":
        return this.afterHighlights();
      case "podium":
        return this.toSummary();
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

  setPhase(phase: Phase, durationMs: number | null, say: SpeechClip[] | null = null) {
    this.state.phase = phase;
    this.state.say = say;
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

  /**
   * Start a phase that speaks. Clips are used only if the required ones are all
   * ready now, and the phase stretches to fit them (plus pad). Otherwise it runs
   * silent, on time. A null duration waits for the facilitator.
   */
  spokenPhase(phase: Phase, baseMs: number | null, lines: TimedLine[], padMs: number) {
    const clips = this.clips(lines);
    let end = 0;
    let cursor = 0;
    for (const c of clips ?? []) {
      cursor = (c.at ?? cursor) + c.ms;
      end = Math.max(end, cursor);
    }
    this.setPhase(phase, baseMs === null ? null : Math.max(baseMs, clips ? end + padMs : 0), clips);
  }

  clips(lines: TimedLine[]): SpeechClip[] | null {
    if (!this.speech?.enabled || !this.state.settings.speech) return null;
    const found = lines.filter((l) => l.text.trim()).map((l) => ({ l, c: this.speech!.get(l, this.speechOpts()) }));
    if (found.some((x) => !x.c && !x.l.optional)) return null;
    const clips = found.flatMap(({ l, c }) => (!c ? [] : l.at !== undefined ? [{ ...c, at: l.at }] : [c]));
    return clips.length ? clips : null;
  }

  /** One of the host's stock lines ("Let's get started!"), said only if its clip is ready. */
  chatter(options: readonly string[]): TimedLine {
    const text = options[Math.floor(Math.random() * options.length)] ?? "";
    return { ...this.line(text, "lib"), optional: true };
  }

  /** A line in the room language; built-in text is cached for good, the rest per room. */
  line(text: string, scope?: SpeechLine["scope"]): SpeechLine {
    return { text, lang: this.state.settings.lang, scope: scope ?? (isLibraryText(text) ? "lib" : "room") };
  }

  // ---------- helpers ----------

  pickPrompts(kind: RoundKind, n: number): string[] {
    const s = this.state;
    const { lang, pack } = s.settings;
    const set = prompts(lang);
    const used = new Set(s.usedPrompts);
    const base =
      kind === "warmup" ? set.warmup : kind === "emoji" ? set.emoji : sprintPrompts(lang, pack);
    // A small pack runs out with big teams; top up from the classic mix.
    const fallback = kind === "retro" && pack !== "mix" ? set.retro : [];
    const custom =
      kind === "retro" ? s.settings.customPrompts.filter((p) => !used.has(p)) : [];
    const pool = [
      ...custom,
      ...shuffle(base.filter((p) => !used.has(p))),
      ...shuffle(fallback.filter((p) => !used.has(p))),
    ];
    while (pool.length < n) pool.push(...shuffle(base));
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

  /** Full players, best score first. */
  ranked() {
    return this.state.players.filter((p) => !p.audience).sort((a, b) => b.score - a.score);
  }

  isConnected(id: string) {
    return !!this.player(id)?.connected;
  }

  expectedIds(): string[] {
    const s = this.state;
    const round = this.round();
    if (!round) return [];
    const everyone = () => this.state.players.filter((p) => !p.audience && this.present(p.id)).map((p) => p.id);
    if (s.phase === "answering") {
      if (!isHeadToHead(round.kind)) return everyone();
      const ids = new Set(round.matchups.flatMap((m) => m.playerIds));
      return [...ids].filter((id) => this.present(id));
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
      if (round.kind === "kudos") return Object.keys(round.kudos ?? {});
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
    if (s.phase === "voting") {
      const m = round.matchups[s.matchupIndex];
      return [...Object.keys(m.votes), ...(m.skips ?? [])];
    }
    if (s.phase === "lashVoting") return Object.keys(round.lashBallots);
    return [];
  }

  name(id: string) {
    return this.player(id)?.name ?? "?";
  }

  plate(id: string): VoterView {
    const p = this.player(id);
    return {
      name: p?.name ?? "?",
      avatar: p?.avatar ?? "🙂",
      color: p?.color ?? PLATE_COLORS[0],
      ...(p?.audience ? { audience: true } : {}),
    };
  }

  matchupView(m: Matchup, reveal: boolean): MatchupView {
    const anon = this.state.settings.anonymous;
    const view: MatchupView = {
      id: m.id,
      prompt: m.prompt,
      answers: m.answers.map((a) => a ?? ""),
    };
    if (reveal && m.closed) {
      const counts = tally(m.votes, m.answers.length);
      const names: string[][] = m.answers.map(() => []);
      const plates: VoterView[][] = m.answers.map(() => []);
      for (const [voter, v] of Object.entries(m.votes)) {
        if (!names[v]) continue;
        names[v].push(this.name(voter));
        plates[v].push(this.plate(voter));
      }
      view.votes = counts;
      view.unanimous = m.unanimous;
      if (m.auto) view.auto = m.auto;
      if (m.skips?.length) view.skips = m.skips.length;
      if (!anon) {
        view.authors = m.playerIds.map((id) => this.name(id));
        view.authorPlates = m.playerIds.map((id) => (this.player(id) ? this.plate(id) : null));
        view.voterNames = names;
        view.voters = plates;
        view.points = m.points;
        if (m.callout) view.callout = m.callout;
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
            owners: a.owners.map((id) => {
              const p = this.plate(id);
              return { name: p.name, avatar: p.avatar, color: p.color };
            }),
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

  /** Kudos without their authors, in the shuffled reveal order. */
  kudosView(round: Round): KudosView[] {
    const order = round.kudosOrder ?? Object.keys(round.kudos ?? {});
    return order
      .map((author) => round.kudos?.[author])
      .filter((k): k is { to: string; text: string } => !!k)
      .map((k) => {
        if (k.to === KUDOS_TEAM) return { to: null, text: k.text };
        const p = this.plate(k.to);
        return { to: p.name, avatar: p.avatar, color: p.color, text: k.text };
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
      kudos: r.kind === "kudos" ? this.kudosView(r) : undefined,
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

  currentPlan() {
    const s = this.state;
    return s.phase === "lobby" ? planRounds(s.settings, this.connectedPlayers().length) : s.plan;
  }

  hostView(): HostView {
    const s = this.state;
    const round = this.round();
    const plan = this.currentPlan();
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
      plan: titledPlan(plan, s.settings.lang),
      remainingMs: this.remainingMs(),
      pausedMs: s.pausedMs,
      doneIds: this.doneIds(),
      expectedIds: this.expectedIds(),
      speechAvailable: !!this.speech?.enabled,
      ...(s.say?.length ? { say: s.say } : {}),
    };
    if (round && ["matchupIntro", "voting", "matchupResult"].includes(s.phase)) {
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
      if (round.kind === "kudos") {
        view.kudos = this.kudosView(round);
        if (round.kudosAt) view.kudosAt = round.kudosAt;
      }
    }
    if (round?.kind === "followup" && s.phase === "answering") {
      view.followupItems = (round.followupItems ?? []).map((text) => ({ text, counts: [] }));
    }
    if (s.phase === "roundResult" && s.leadChange) view.leadChange = s.leadChange;
    if (s.phase === "answering" && round && isHeadToHead(round.kind) && round.matchups.length) {
      const first = round.matchups[0].playerIds[0];
      view.promptsEach = round.matchups.filter((m) => m.playerIds.includes(first)).length;
    }
    if (s.phase === "highlights") view.highlights = this.highlights();
    if (s.phase === "summary") view.summary = this.summary();
    return view;
  }

  playerView(id: string): PlayerView {
    const s = this.state;
    const round = this.round();
    const me = this.player(id) ?? null;
    const anon = s.settings.anonymous;
    const view: PlayerView = {
      role: "player",
      code: this.room.id.toUpperCase(),
      phase: s.phase,
      lang: s.settings.lang,
      you: me ? { ...me, score: anon ? 0 : me.score } : null,
      anonymous: anon,
      remainingMs: this.remainingMs(),
      roundKind: round?.kind,
      roundTitle: round?.title,
      playerCount: this.connectedPlayers().length,
      minPlayers: MIN_PLAYERS,
      theme: s.settings.theme,
    };
    if (!me) return view;

    if (me.vip) {
      const plan = this.currentPlan();
      const matchPhase = ["matchupIntro", "voting", "matchupResult"].includes(s.phase);
      view.vipControls = {
        canStart: s.phase === "lobby" && this.connectedPlayers().length >= MIN_PLAYERS && plan.length > 0,
        timed: s.deadline !== null,
        paused: s.pausedMs !== null,
        roundNumber: s.roundIndex + 1,
        roundCount: plan.length,
        ...(matchPhase && round
          ? { matchupNumber: s.matchupIndex + 1, matchupCount: round.matchups.length }
          : {}),
      };
    }
    if (s.phase === "lobby") {
      view.takenAvatars = s.players.filter((p) => !p.audience && p.id !== id).map((p) => p.avatar);
    }
    if (!anon && !me.audience && ["roundResult", "podium", "summary"].includes(s.phase)) {
      const ranked = this.ranked();
      view.myRank = {
        rank: ranked.filter((p) => p.score > me.score).length + 1,
        of: ranked.length,
        score: me.score,
      };
    }
    if (!round) return view;

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
      } else if (round.kind === "kudos") {
        view.kudosForm = {
          teammates: s.players
            .filter((p) => p.id !== id)
            .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, color: p.color })),
          mine: round.kudos?.[id] ?? null,
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
    if (s.phase === "matchupIntro") {
      view.upNext = round.matchups[s.matchupIndex]?.prompt;
    }
    if (s.phase === "voting") {
      const m = round.matchups[s.matchupIndex];
      view.vote = {
        matchupId: m.id,
        prompt: m.prompt,
        answers: m.answers.map((a) => a ?? ""),
        canVote: !m.playerIds.includes(id),
        myChoice: m.votes[id] ?? null,
        skipped: !!m.skips?.includes(id),
      };
    }
    if (s.phase === "matchupResult") {
      const r = myResult(round.matchups[s.matchupIndex], id, anon);
      if (r) view.myResult = r;
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
    const view = st.role === "player" ? this.playerView(st.pid) : this.hostView();
    const msg: ServerMessage = { t: "view", view };
    conn.send(JSON.stringify(msg));
  }

  error(conn: Connection, message: string) {
    const msg: ServerMessage = { t: "error", message };
    conn.send(JSON.stringify(msg));
  }

  /** Persist and push fresh views to everyone. */
  commit() {
    if (this.state.phase === "lobby") this.prefetchLobby();
    void this.room.storage.put("state", this.state);
    for (const c of this.room.getConnections()) this.sendView(c);
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

let library: Set<string> | null = null;
/** Built-in prompts and titles: safe to cache for good and share between rooms. */
function isLibraryText(text: string) {
  if (!library) {
    const set = new Set<string>(Object.values(DEFAULT_LASH_PROMPT));
    for (const lang of LANGS) {
      const p = prompts(lang);
      for (const list of [p.warmup, p.retro, p.emoji, p.safetyQuips, ...Object.values(p.packs)]) list.forEach((x) => set.add(x));
      for (const kind of [...TOGGLEABLE_ROUNDS, "followup" as const])
        for (let total = 1; total <= 3; total++)
          for (let i = 0; i < total; i++) set.add(roundTitle(kind, i, total, lang));
    }
    library = set;
  }
  return library.has(text);
}

/** How a closed matchup went for one phone: as an author, or as a voter. */
function myResult(m: Matchup | undefined, id: string, anon: boolean): MyResult | null {
  if (!m?.closed) return null;
  const counts = tally(m.votes, m.answers.length);
  const w = winnerOf(counts);
  const idx = m.playerIds.indexOf(id);
  if (idx >= 0) {
    return {
      kind: "author",
      won: w === null ? null : w === idx,
      unanimous: !!m.unanimous && w === idx,
      votes: [counts[idx], ...counts.filter((_, i) => i !== idx).sort((a, b) => b - a)],
      points: anon ? null : (m.points?.[idx] ?? 0),
      ...(m.auto?.[idx] ? { auto: true } : {}),
    };
  }
  if (id in m.votes) return { kind: "voter", pickedWinner: w === null ? null : m.votes[id] === w };
  return null;
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
  const discussion = clamp(s.discussionSeconds, NO_TALK, 600, DEFAULT_SETTINGS.discussionSeconds);
  const lang = LANGS.includes(s.lang) ? s.lang : DEFAULT_SETTINGS.lang;
  return {
    anonymous: !!s.anonymous,
    rounds: TOGGLEABLE_ROUNDS.filter((r) => (Array.isArray(s.rounds) ? s.rounds : []).includes(r)),
    answerSeconds: clamp(s.answerSeconds, 20, 300, DEFAULT_SETTINGS.answerSeconds),
    voteSeconds: clamp(s.voteSeconds, 10, 120, DEFAULT_SETTINGS.voteSeconds),
    customPrompts: list(s.customPrompts, 30, 120),
    lashPrompt: clean(s.lashPrompt, 120) || DEFAULT_LASH_PROMPT[lang],
    lashMaxAnswers: clamp(s.lashMaxAnswers, 1, 3, DEFAULT_SETTINGS.lashMaxAnswers),
    lashVotes: clamp(s.lashVotes, 1, 5, DEFAULT_SETTINGS.lashVotes),
    sprintRounds: clamp(s.sprintRounds, 0, 3, DEFAULT_SETTINGS.sprintRounds),
    // Under 15 s is too short to talk; treat it as "wait for me" only when 0.
    discussionSeconds: discussion <= 0 ? discussion : Math.max(15, discussion),
    previousItems: list(s.previousItems, MAX_PREVIOUS_ITEMS, MAX_LASH_LENGTH),
    lang,
    pack: PACKS.includes(s.pack) ? s.pack : DEFAULT_SETTINGS.pack,
    speech: s.speech !== false,
    trios: s.trios !== false,
    promptsEach: clamp(s.promptsEach, 0, 2, DEFAULT_SETTINGS.promptsEach),
    theme: THEMES.includes(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
  };
}

/**
 * Who meets whom. Everyone gets `each` prompts (two, or one in big teams).
 * Two each without trios is a circle of pairs. Otherwise groups of three (with
 * trios) or two, plus whatever the numbers need to come out even, reshuffled
 * until nobody is in a group twice and as few people as possible meet twice.
 */
export function groupPlayers(ids: string[], trios: boolean, each: 1 | 2 = 2): string[][] {
  const n = ids.length;
  const circle = () => ids.map((id, i) => [id, ids[(i + 1) % n]]);
  if (each === 2 && (!trios || n < 4)) return circle();
  const slots = each * n;
  let threes: number;
  let pairs: number;
  if (trios) {
    pairs = [0, 2, 1][slots % 3];
    threes = (slots - 2 * pairs) / 3;
  } else {
    // One prompt each in pairs; an odd one out makes a single three-way.
    threes = slots % 2;
    pairs = (slots - 3 * threes) / 2;
  }
  if (pairs < 0 || slots < 2) return circle();
  const sizes = [...Array<number>(threes).fill(3), ...Array<number>(pairs).fill(2)];
  let best: string[][] | null = null;
  let bestRepeats = Infinity;
  for (let attempt = 0; attempt < 500 && bestRepeats > 0; attempt++) {
    const seq = each === 2 ? [...shuffle(ids), ...shuffle(ids)] : shuffle(ids);
    const groups: string[][] = [];
    let k = 0;
    for (const size of shuffle(sizes)) {
      const g = seq.slice(k, k + size);
      k += size;
      if (new Set(g).size < size) break;
      groups.push(g);
    }
    if (groups.length < sizes.length) continue;
    const met = new Set<string>();
    let repeats = 0;
    for (const g of groups)
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) {
          const key = [g[i], g[j]].sort().join("|");
          if (met.has(key)) repeats++;
          met.add(key);
        }
    if (repeats < bestRepeats) {
      best = groups;
      bestRepeats = repeats;
    }
  }
  return best ?? circle();
}

/** Every stock line the host can say in one language (to generate them ahead of time). */
function chatterLines(lang: Lang): string[] {
  const s = strings(lang).spoken;
  return [
    ...s.welcome,
    ...Object.values(s.write).flat(),
    ...s.vote,
    ...Object.values(s.result).flat(),
    ...s.roundDone,
    ...Object.values(s.poll).flat(),
    ...s.lashVote,
    ...s.lashResult,
    ...s.wrap,
  ];
}
