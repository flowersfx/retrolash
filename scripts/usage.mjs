// Summarise the usage file (one JSON line per game start and finish, counts only).
//   node scripts/usage.mjs usage.jsonl
// Download it from the Azure Files share first; see infra/README.md ("Usage numbers").
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "usage.jsonl";
const events = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const starts = events.filter((e) => e.event === "start");
const games = events.filter((e) => e.event === "game");
const avg = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "-");
const share = (xs, f) => (xs.length ? `${Math.round((xs.filter(f).length / xs.length) * 100)}%` : "-");
const byMonth = {};
for (const g of games) byMonth[g.at.slice(0, 7)] = (byMonth[g.at.slice(0, 7)] ?? 0) + 1;

console.log(`Games started   ${starts.length}`);
console.log(`Games finished  ${games.length}`);
console.log(`Players         ${avg(games.map((g) => g.players))} on average (+${avg(games.map((g) => g.audience))} audience)`);
console.log(`Length          ${avg(games.map((g) => g.minutes))} min on average`);
console.log(`Action items    ${avg(games.map((g) => g.actionItems))} per game, ${avg(games.map((g) => g.owned))} with an owner`);
console.log(`Auto-answers    ${avg(games.map((g) => g.autoAnswers))} per game`);
console.log(`Swedish         ${share(games, (g) => g.lang === "sv")}`);
console.log(`Speech on       ${share(games, (g) => g.speech)}`);
console.log(`Anonymous mode  ${share(games, (g) => g.anonymous)}`);
console.log(`Per month       ${Object.entries(byMonth).map(([m, n]) => `${m}: ${n}`).join(", ") || "-"}`);
