import { FOLLOWUP_OPTIONS, MOODS, type HostView } from "../shared/types";

export function summaryToMarkdown(view: HostView): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# Retro ${date}`, ""];
  const rounds = view.summary ?? [];

  const lash = rounds.find((r) => r.kind === "lastlash");
  if (lash?.lashAnswers?.length) {
    lines.push(`## Action items`, "", `_${lash.lashPrompt}_`, "");
    for (const a of lash.lashAnswers) {
      const owners = a.owners?.length ? ` — owner: ${a.owners.map((o) => o.name).join(", ")}` : "";
      const by = a.author ? ` (idea: ${a.author})` : "";
      lines.push(`- [ ] ${a.text} (${a.votes ?? 0} votes)${owners}${by}`);
    }
    lines.push("");
  }

  const followup = rounds.find((r) => r.kind === "followup")?.followupItems;
  if (followup?.length) {
    lines.push(`## Last retro's action items`, "");
    for (const f of followup) {
      const tally = FOLLOWUP_OPTIONS.map((o, i) => `${o.emoji} ${f.counts[i] ?? 0}`).join(" · ");
      lines.push(`- ${f.text}: ${tally}`);
    }
    lines.push("");
  }

  const mood = rounds.find((r) => r.kind === "checkin")?.moodCounts;
  if (mood) {
    lines.push(`## Sprint weather`, "", MOODS.map((m, i) => `${m.emoji} ${m.label}: ${mood[i] ?? 0}`).join(" · "), "");
  }

  for (const r of rounds) {
    if (r.matchups.length === 0) continue;
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

  const players = view.players.filter((p) => !p.audience);
  if (!view.settings.anonymous && players.length) {
    lines.push(`## Scores`, "");
    [...players]
      .sort((a, b) => b.score - a.score)
      .forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${p.score}`));
    lines.push("");
  }
  return lines.join("\n");
}
