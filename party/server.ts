import type * as Party from "partykit/server";
import {
  DEFAULT_SETTINGS,
  MAX_ANSWER_LENGTH,
  MAX_LASH_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_TITLES,
  type ClientMessage,
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
import { RETRO_PROMPTS, WARMUP_PROMPTS, shuffle } from "../shared/prompts";

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
}

interface Round {
  kind: RoundKind;
  title: string;
  matchups: Matchup[];
  lashPrompt?: string;
  lashAnswers: LashAnswer[];
  lashSubmitted: string[];
  lashBallots: Record<string, string[]>;
}

interface GameState {
  phase: Phase;
  players: Player[];
  settings: Settings;
  rounds: Round[];
  roundIndex: number;
  matchupIndex: number;
  deadline: number | null;
  usedPrompts: string[];
}

type ConnState = { role: "host" } | { role: "player" } | undefined;

const AVATARS = [
  "🦊", "🐙", "🦉", "🐸", "🦄", "🐝", "🐳", "🦖", "🐧", "🦔", "🐢", "🦩",
  "🐼", "🦁", "🐌", "🦦", "🐨", "🦜", "🐞", "🦀",
];

const ROUND_MULTIPLIER: Record<RoundKind, number> = {
  warmup: 1,
  retro: 2,
  lastlash: 3,
};

const INTRO_MS = 4000;
const WARMUP_RESULT_MS = 7000;

function freshState(settings: Settings = DEFAULT_SETTINGS): GameState {
  return {
    phase: "lobby",
    players: [],
    settings,
    rounds: [],
    roundIndex: 0,
    matchupIndex: 0,
    deadline: null,
    usedPrompts: [],
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";

export default class RetroServer implements Party.Server {
  state: GameState = freshState();
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly room: Party.Room) {}

  async onStart() {
    const saved = await this.room.storage.get<GameState>("state");
    if (saved) {
      this.state = saved;
      // Nobody is connected right after a restart.
      this.state.players.forEach((p) => (p.connected = false));
      this.armTimer();
    }
  }

  // ---------- connection lifecycle ----------

  onConnect(conn: Party.Connection) {
    // Role is set by the hello message; send nothing until then.
    void conn;
  }

  onClose(conn: Party.Connection) {
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

  onMessage(raw: string | ArrayBuffer | ArrayBufferView, conn: Party.Connection) {
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
        return this.onPlayerHello(conn, msg.name);
    }

    if (role === "host") return this.onHostMessage(msg);
    if (role === "player") return this.onPlayerMessage(conn.id, msg);
  }

  // ---------- player join ----------

  onPlayerHello(conn: Party.Connection, rawName: string) {
    let p = this.player(conn.id);
    if (!p) {
      const name = clean(rawName, 16);
      if (!name) return this.error(conn, "Please enter a name.");
      if (this.state.players.length >= MAX_PLAYERS)
        return this.error(conn, "This room is full.");
      const used = new Set(this.state.players.map((x) => x.avatar));
      const avatar =
        AVATARS.find((a) => !used.has(a)) ??
        AVATARS[this.state.players.length % AVATARS.length];
      let finalName = name;
      let n = 2;
      while (
        this.state.players.some(
          (x) => x.name.toLowerCase() === finalName.toLowerCase(),
        )
      ) {
        finalName = `${name} ${n++}`;
      }
      p = { id: conn.id, name: finalName, avatar, connected: true, score: 0 };
      this.state.players.push(p);
    }
    p.connected = true;
    conn.setState({ role: "player" });
    this.commit();
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
        if (s.phase !== "lobby") return;
        s.players = s.players.filter((p) => p.id !== msg.playerId);
        for (const c of this.room.getConnections()) {
          if (c.id === msg.playerId) {
            this.error(c, "You were removed from the room.");
            c.setState(undefined);
          }
        }
        break;
      }
      case "start": {
        if (s.phase !== "lobby") return;
        if (this.connectedPlayers().length < MIN_PLAYERS) return;
        if (s.settings.rounds.length === 0) return;
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
      case "restart": {
        const players = s.players.map((p) => ({ ...p, score: 0 }));
        this.state = freshState(s.settings);
        this.state.players = players;
        break;
      }
      default:
        return;
    }
    this.commit();
  }

  // ---------- player actions ----------

  onPlayerMessage(playerId: string, msg: ClientMessage) {
    const s = this.state;
    const round = this.round();
    if (!this.player(playerId)) return;

    switch (msg.t) {
      case "answer": {
        if (s.phase !== "answering" || !round) return;
        const m = round.matchups.find((x) => x.id === msg.matchupId);
        if (!m) return;
        const idx = m.playerIds.indexOf(playerId);
        if (idx < 0) return;
        const text = clean(msg.text, MAX_ANSWER_LENGTH);
        if (!text) return;
        m.answers[idx] = text;
        break;
      }
      case "lashAnswers": {
        if (s.phase !== "answering" || round?.kind !== "lastlash") return;
        const texts = (Array.isArray(msg.texts) ? msg.texts : [])
          .map((t) => clean(t, MAX_LASH_LENGTH))
          .filter(Boolean)
          .slice(0, s.settings.lashMaxAnswers);
        if (texts.length === 0) return;
        round.lashAnswers = round.lashAnswers.filter(
          (a) => a.playerId !== playerId,
        );
        for (const text of texts)
          round.lashAnswers.push({ id: uid(), playerId, text, votes: 0 });
        if (!round.lashSubmitted.includes(playerId))
          round.lashSubmitted.push(playerId);
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
          round.lashAnswers
            .filter((a) => a.playerId !== playerId)
            .map((a) => a.id),
        );
        const ids = [...new Set(Array.isArray(msg.answerIds) ? msg.answerIds : [])]
          .filter((id) => allowed.has(id))
          .slice(0, s.settings.lashVotes);
        round.lashBallots[playerId] = ids;
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
    const kind = s.settings.rounds[s.roundIndex];
    s.rounds[s.roundIndex] = {
      kind,
      title: ROUND_TITLES[kind],
      matchups: [],
      lashAnswers: [],
      lashSubmitted: [],
      lashBallots: {},
      lashPrompt: kind === "lastlash" ? s.settings.lashPrompt : undefined,
    };
    s.matchupIndex = 0;
    this.setPhase("roundIntro", INTRO_MS);
  }

  beginAnswering() {
    const round = this.round()!;
    if (round.kind !== "lastlash") {
      const players = shuffle(this.connectedPlayers());
      const prompts = this.pickPrompts(round.kind, players.length);
      round.matchups = players.map((p, i) => ({
        id: uid(),
        prompt: prompts[i],
        playerIds: [p.id, players[(i + 1) % players.length].id],
        answers: [null, null],
        votes: {},
      }));
    }
    this.setPhase("answering", this.state.settings.answerSeconds * 1000);
  }

  endAnswering() {
    const round = this.round()!;
    if (round.kind === "lastlash") {
      round.lashAnswers = shuffle(round.lashAnswers);
      if (round.lashAnswers.length === 0) return this.nextRound();
      this.setPhase(
        "lashVoting",
        Math.max(45, this.state.settings.voteSeconds * 2) * 1000,
      );
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
    if (this.expectedIds().length === 0) this.endVoting();
  }

  endVoting() {
    const round = this.round()!;
    const m = round.matchups[this.state.matchupIndex];
    const counts: [number, number] = [0, 0];
    Object.values(m.votes).forEach((v) => counts[v]++);
    const total = counts[0] + counts[1];
    const mult = ROUND_MULTIPLIER[round.kind];
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
    // Warm-up results auto-advance; retro results wait so the team can talk.
    this.setPhase(
      "matchupResult",
      round.kind === "warmup" ? WARMUP_RESULT_MS : null,
    );
  }

  nextMatchup() {
    this.state.matchupIndex++;
    this.beginVoting();
  }

  endRound() {
    this.setPhase("roundResult", null);
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
      if (p) p.score += a.votes * 100 * ROUND_MULTIPLIER.lastlash;
    }
    this.setPhase("lashResult", null);
  }

  nextRound() {
    const s = this.state;
    s.roundIndex++;
    if (s.roundIndex >= s.settings.rounds.length) {
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
        return this.nextRound();
      case "lashVoting":
        return this.endLashVoting();
      case "lashResult":
        return this.nextRound();
    }
  }

  checkAllDone() {
    const phase = this.state.phase;
    if (!["answering", "voting", "lashVoting"].includes(phase)) return;
    const expected = this.expectedIds();
    if (expected.length === 0) return;
    const done = new Set(this.doneIds());
    if (expected.every((id) => done.has(id))) this.advance();
  }

  setPhase(phase: Phase, durationMs: number | null) {
    this.state.phase = phase;
    this.state.deadline = durationMs === null ? null : Date.now() + durationMs;
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
    const base = kind === "warmup" ? WARMUP_PROMPTS : RETRO_PROMPTS;
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

  connectedPlayers() {
    return this.state.players.filter((p) => p.connected);
  }

  isConnected(id: string) {
    return !!this.player(id)?.connected;
  }

  expectedIds(): string[] {
    const s = this.state;
    const round = this.round();
    if (!round) return [];
    if (s.phase === "answering") {
      if (round.kind === "lastlash") return this.connectedPlayers().map((p) => p.id);
      const ids = new Set(round.matchups.flatMap((m) => m.playerIds));
      return [...ids].filter((id) => this.isConnected(id));
    }
    if (s.phase === "voting") {
      const m = round.matchups[s.matchupIndex];
      return this.connectedPlayers()
        .filter((p) => !m.playerIds.includes(p.id))
        .map((p) => p.id);
    }
    if (s.phase === "lashVoting") {
      // Players who only see their own answers have nothing to vote on.
      return this.connectedPlayers()
        .filter((p) => round.lashAnswers.some((a) => a.playerId !== p.id))
        .map((p) => p.id);
    }
    return [];
  }

  doneIds(): string[] {
    const s = this.state;
    const round = this.round();
    if (!round) return [];
    if (s.phase === "answering") {
      if (round.kind === "lastlash") return [...round.lashSubmitted];
      const ids = new Set(round.matchups.flatMap((m) => m.playerIds));
      return [...ids].filter((id) =>
        round.matchups.every((m) => {
          const i = m.playerIds.indexOf(id);
          return i < 0 || m.answers[i] !== null;
        }),
      );
    }
    if (s.phase === "voting") {
      return Object.keys(round.matchups[s.matchupIndex].votes);
    }
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
      for (const [voter, v] of Object.entries(m.votes)) {
        counts[v]++;
        voters[v].push(this.name(voter));
      }
      view.votes = counts;
      view.unanimous = m.unanimous;
      if (!anon) {
        view.authors = [this.name(m.playerIds[0]), this.name(m.playerIds[1])];
        view.voterNames = voters;
        view.points = m.points;
      }
    }
    return view;
  }

  lashView(round: Round, reveal: boolean): LashAnswerView[] {
    const anon = this.state.settings.anonymous;
    const list = round.lashAnswers.map((a) => ({
      id: a.id,
      text: a.text,
      ...(reveal ? { votes: a.votes } : {}),
      ...(reveal && !anon ? { author: this.name(a.playerId) } : {}),
    }));
    if (reveal) list.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
    return list;
  }

  summary(): SummaryRound[] {
    return this.state.rounds.map((r) => ({
      kind: r.kind,
      title: r.title,
      matchups: r.matchups
        .filter((m) => m.closed)
        .map((m) => this.matchupView(m, true)),
      lashPrompt: r.lashPrompt,
      lashAnswers: r.kind === "lastlash" ? this.lashView(r, true) : undefined,
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
    const view: HostView = {
      role: "host",
      code: this.room.id.toUpperCase(),
      phase: s.phase,
      settings: s.settings,
      players: this.publicPlayers(),
      roundNumber: s.roundIndex + 1,
      roundCount: s.settings.rounds.length,
      roundKind: round?.kind,
      roundTitle: round?.title,
      remainingMs: this.remainingMs(),
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

    if (s.phase === "answering") {
      if (round.kind === "lastlash") {
        view.lashPrompt = round.lashPrompt;
        view.lashMaxAnswers = s.settings.lashMaxAnswers;
        view.myLashAnswers = round.lashAnswers
          .filter((a) => a.playerId === id)
          .map((a) => a.text);
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
        answers: round.lashAnswers.map((a) => ({
          id: a.id,
          text: a.text,
          mine: a.playerId === id,
        })),
        votesAllowed: Math.min(s.settings.lashVotes, others.length),
        myVotes: round.lashBallots[id] ?? [],
        submitted: id in round.lashBallots,
      };
    }
    return view;
  }

  sendView(conn: Party.Connection) {
    const st = conn.state as ConnState;
    if (!st) return;
    const view = st.role === "host" ? this.hostView() : this.playerView(conn.id);
    const msg: ServerMessage = { t: "view", view };
    conn.send(JSON.stringify(msg));
  }

  error(conn: Party.Connection, message: string) {
    const msg: ServerMessage = { t: "error", message };
    conn.send(JSON.stringify(msg));
  }

  /** Persist and push fresh views to everyone. */
  commit() {
    void this.room.storage.put("state", this.state);
    for (const c of this.room.getConnections()) this.sendView(c);
  }
}

function sanitizeSettings(s: Settings): Settings {
  const kinds: RoundKind[] = ["warmup", "retro", "lastlash"];
  const clamp = (n: unknown, lo: number, hi: number, d: number) =>
    typeof n === "number" && Number.isFinite(n)
      ? Math.min(hi, Math.max(lo, Math.round(n)))
      : d;
  return {
    anonymous: !!s.anonymous,
    rounds: (Array.isArray(s.rounds) ? s.rounds : []).filter((r) =>
      kinds.includes(r),
    ),
    answerSeconds: clamp(s.answerSeconds, 20, 300, DEFAULT_SETTINGS.answerSeconds),
    voteSeconds: clamp(s.voteSeconds, 10, 120, DEFAULT_SETTINGS.voteSeconds),
    customPrompts: (Array.isArray(s.customPrompts) ? s.customPrompts : [])
      .map((p) => clean(p, 120))
      .filter(Boolean)
      .slice(0, 30),
    lashPrompt: clean(s.lashPrompt, 120) || DEFAULT_SETTINGS.lashPrompt,
    lashMaxAnswers: clamp(s.lashMaxAnswers, 1, 3, DEFAULT_SETTINGS.lashMaxAnswers),
    lashVotes: clamp(s.lashVotes, 1, 5, DEFAULT_SETTINGS.lashVotes),
  };
}
