// Fill a room with bot players for testing without a pile of phones.
//   node scripts/bots.mjs ABCD 4 [host:port] [audienceCount]
//   node scripts/bots.mjs ABCD 4 retrolash.<env>.swedencentral.azurecontainerapps.io 1
// Bots answer, vote, react and volunteer at random. Audience bots only vote and react.
// They reconnect if the server restarts. Ctrl+C to stop.
// BOT_VOTE=0 makes every bot vote for the left answer (forces RETROLASH clean sweeps).

const [code = "TEST", countArg = "4", hostArg = "localhost:1999", audienceArg = "0"] =
  process.argv.slice(2);
const host = hostArg.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
// Plain ws for local/LAN dev servers, TLS for anything deployed.
const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
const scheme = isLocal ? "ws" : "wss";
const NAMES = ["Ada", "Linus", "Grace", "Ken", "Barbara", "Dennis", "Margaret", "Alan"];
const QUIPS = [
  "Blame the intern", "It was DNS", "More meetings", "A very large spreadsheet",
  "Coffee, mostly", "Rewrite it in Rust", "Nobody read the ticket", "Works on my machine",
  "Ship it Friday", "A haunted YAML file",
];
const EMOJI = ["🔥🐶☕", "🤡🎪", "🙈🙉🙊", "📉😬", "🐌⏳", "🚀💥", "🧯🔥"];
const REACTIONS = ["😂", "🔥", "👏", "😮"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const AVATARS = ["🦊", "🐙", "🦉", "🐸", "🦄", "🐝", "🐳", "🦖"];
const COLORS = ["#ffcf33", "#ff5ca8", "#3ee0c5", "#7c8cff", "#ff8a3d", "#9be15d", "#c77dff", "#4cc9f0"];
const KUDOS = ["Thanks for the code reviews", "Saved the demo", "Best rubber duck", "Kept us calm"];
const delay = () => 300 + Math.random() * 1500;

function bot(i, audience) {
  const id = `bot-${code}-${audience ? "a" : "p"}${i}`;
  const name = audience ? `PO ${i + 1} 🍿` : `${NAMES[i % NAMES.length]} 🤖`;
  const done = new Set();
  const once = (key, fn) => {
    if (done.has(key)) return;
    done.add(key);
    setTimeout(fn, delay());
  };
  let ws;
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
  const connect = () => {
    ws = new WebSocket(`${scheme}://${host}/parties/main/${code.toLowerCase()}?_pk=${id}`);
    ws.onopen = () => send({ t: "helloPlayer", name, audience, avatar: pick(AVATARS), color: pick(COLORS) });
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t === "error") return console.log(`${name}: ${msg.message}`);
      if (msg.t !== "view") return;
      const v = msg.view;
      const round = v.roundTitle;
      if (v.phase === "answering" && v.tasks)
        for (const t of v.tasks)
          if (t.answer === null)
            once(`a:${t.matchupId}`, () =>
              send({ t: "answer", matchupId: t.matchupId, text: v.roundKind === "emoji" ? pick(EMOJI) : pick(QUIPS) }),
            );
      if (v.phase === "answering" && v.roundKind === "lastlash" && !v.myLashAnswers?.length)
        once(`lash:${round}`, () => send({ t: "lashAnswers", texts: [pick(QUIPS)] }));
      if (v.phase === "answering" && v.roundKind === "checkin" && v.myMood == null)
        once(`mood:${round}`, () => send({ t: "mood", value: Math.floor(Math.random() * 5) }));
      if (v.phase === "answering" && v.followup)
        once(`fu:${round}`, () =>
          send({ t: "followup", answers: v.followup.items.map(() => Math.floor(Math.random() * 3)) }),
        );
      if (v.phase === "answering" && v.kudosForm && !v.kudosForm.mine) {
        const to = Math.random() < 0.2 ? "team" : pick(v.kudosForm.teammates).id;
        once(`k:${round}`, () => send({ t: "kudos", to, text: pick(KUDOS) }));
      }
      if (v.phase === "voting" && v.vote?.canVote && v.vote.myChoice === null)
        once(`v:${v.vote.matchupId}`, () =>
          send({ t: "vote", matchupId: v.vote.matchupId, choice: process.env.BOT_VOTE ? Number(process.env.BOT_VOTE) : Math.random() < 0.5 ? 0 : 1 }),
        );
      if (v.phase === "lashVoting" && v.lashBallot && !v.lashBallot.submitted) {
        const options = v.lashBallot.answers.filter((a) => !a.mine).map((a) => a.id);
        const ids = options.sort(() => Math.random() - 0.5).slice(0, v.lashBallot.votesAllowed);
        once(`lv:${round}`, () => send({ t: "lashVote", answerIds: ids }));
      }
      if (v.phase === "lashResult" && v.claimable?.length && Math.random() < 0.5)
        once(`claim:${round}`, () => send({ t: "claim", answerId: pick(v.claimable).id, on: true }));
      if (["matchupResult", "roundResult", "pollResult"].includes(v.phase) && Math.random() < 0.4)
        once(`r:${v.phase}:${round}:${Date.now() >> 12}`, () => send({ t: "react", emoji: pick(REACTIONS) }));
    };
    ws.onclose = () => setTimeout(connect, 1000);
    ws.onerror = () => {};
  };
  connect();
}

const players = Number(countArg);
const audience = Number(audienceArg);
for (let i = 0; i < players; i++) bot(i, false);
for (let i = 0; i < audience; i++) bot(i, true);
console.log(`${players} bots + ${audience} audience joining room ${code} on ${host}`);
