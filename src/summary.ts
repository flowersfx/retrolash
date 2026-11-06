import type { HostView } from "../shared/types";

export function summaryToMarkdown(view: HostView): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# Retro ${date}`, ""];
  const rounds = view.summary ?? [];

  const lash = rounds.find((r) => r.kind === "lastlash");
  if (lash?.lashAnswers?.length) {
    lines.push(`## Action items`, "", `_${lash.lashPrompt}_`, "");
    for (const a of lash.lashAnswers) {
      const by = a.author ? ` — ${a.author}` : "";
      lines.push(`- [ ] ${a.text} (${a.votes ?? 0} votes)${by}`);
    }
    lines.push("");
  }

  for (const r of rounds) {
    if (r.kind === "lastlash" || r.matchups.length === 0) continue;
    lines.push(`## ${r.title}`, "");
    for (const m of r.matchups) {
      lines.push(`**${m.prompt}**`, "");
      m.answers.forEach((a, i) => {
        if (!a) return;
        const by = m.authors ? ` — ${m.authors[i]}` : "";
        lines.push(`- ${a} (${m.votes?.[i] ?? 0} votes)${by}`);
      });
      lines.push("");
    }
  }

  if (!view.settings.anonymous && view.players.length) {
    lines.push(`## Scores`, "");
    [...view.players]
      .sort((a, b) => b.score - a.score)
      .forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${p.score}`));
    lines.push("");
  }
  return lines.join("\n");
}
