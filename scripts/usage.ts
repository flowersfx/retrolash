// Summarise the usage file (one JSON line per game start and finish, counts only).
//   npx tsx scripts/usage.ts usage.jsonl [--all]
// Download it from the Azure Files share first; see infra/README.md ("Usage numbers").
// Test games (bots) are left out unless you pass --all.
import { readFileSync } from "node:fs";
import { parseUsage, summarize } from "../server/usage";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "usage.jsonl";
const s = summarize(parseUsage(readFileSync(file, "utf8")), { includeTests: args.includes("--all") });
const pct = (x: number) => `${Math.round(x * 100)}%`;

console.log(`Games finished  ${s.games} (${s.thisMonth} this month)${s.tests ? `, ${s.tests} test lines left out` : ""}`);
console.log(`Abandoned       ${s.abandoned}`);
console.log(`Players         ${s.players} taking part on average`);
console.log(`Length          ${s.minutes} min on average`);
console.log(`Action items    ${s.actionItems} in total, ${pct(s.ownedShare)} with an owner`);
console.log(`Kudos           ${s.kudos} in total`);
console.log(`Extra screens   ${s.withScreens} game(s)`);
console.log(`Swedish         ${pct(s.swedish)}`);
console.log(`Speech on       ${pct(s.speech)}`);
console.log(`Anonymous mode  ${pct(s.anonymous)}`);
console.log(`Last played     ${s.lastPlayed?.slice(0, 10) ?? "-"}`);
console.log(`Per month       ${Object.entries(s.perMonth).map(([m, n]) => `${m}: ${n}`).join(", ") || "-"}`);
