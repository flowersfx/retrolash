// Fill a room with bot players for testing without a pile of phones.
//   node scripts/bots.mjs ABCD 4 [host:port]
//   node scripts/bots.mjs ABCD 4 retrolash.<you>.partykit.dev   (deployed server)
// Bots answer and vote randomly. Ctrl+C to stop.

const [code = "TEST", countArg = "4", hostArg = "localhost:1999"] = process.argv.slice(2);
const host = hostArg.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
// Plain ws for local/LAN dev servers, TLS for anything deployed.
const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
const scheme = isLocal ? "ws" : "wss";
const count = Number(countArg);
const NAMES = ["Ada", "Linus", "Grace", "Ken", "Barbara", "Dennis", "Margaret", "Alan"];
const QUIPS = [
  "Blame the intern", "It was DNS", "More meetings", "A very large spreadsheet",
  "Coffee, mostly", "Rewrite it in Rust", "Nobody read the ticket", "Works on my machine",
  "Ship it Friday", "A haunted YAML file",
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const delay = () => 300 + Math.random() * 1500;

for (let i = 0; i < count; i++) {
  const id = `bot-${code}-${i}`;
  const ws = new WebSocket(`${scheme}://${host}/parties/main/${code.toLowerCase()}?_pk=${id}`);
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  let lastKey = "";
  ws.onopen = () => send({ t: "helloPlayer", name: `${NAMES[i % NAMES.length]} 🤖` });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t !== "view") return;
    const v = msg.view;
    if (v.phase === "answering" && v.tasks) {
      const task = v.tasks.find((t) => t.answer === null);
      const key = `a:${task?.matchupId}`;
      if (task && key !== lastKey) {
        lastKey = key;
        setTimeout(() => send({ t: "answer", matchupId: task.matchupId, text: pick(QUIPS) }), delay());
      }
    }
    if (v.phase === "answering" && v.lashPrompt && !v.myLashAnswers?.length && lastKey !== "lash") {
      lastKey = "lash";
      setTimeout(() => send({ t: "lashAnswers", texts: [pick(QUIPS)] }), delay());
    }
    if (v.phase === "voting" && v.vote?.canVote && v.vote.myChoice === null) {
      const key = `v:${v.vote.matchupId}`;
      if (key !== lastKey) {
        lastKey = key;
        setTimeout(() => send({ t: "vote", matchupId: v.vote.matchupId, choice: Math.random() < 0.5 ? 0 : 1 }), delay());
      }
    }
    if (v.phase === "lashVoting" && v.lashBallot && !v.lashBallot.submitted && lastKey !== "lv") {
      lastKey = "lv";
      const options = v.lashBallot.answers.filter((a) => !a.mine).map((a) => a.id);
      const ids = options.sort(() => Math.random() - 0.5).slice(0, v.lashBallot.votesAllowed);
      setTimeout(() => send({ t: "lashVote", answerIds: ids }), delay());
    }
  };
  ws.onclose = () => console.log(`bot ${i} disconnected`);
}
console.log(`${count} bots joining room ${code} on ${host}`);
