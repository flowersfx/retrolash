import { FOLLOWUP_OPTIONS, MOODS, places, type HostView } from "../shared/types";
import { strings } from "../shared/i18n";

/** The summary as Markdown, in the room's language. parsePreviousItems reads both languages back. */
export function summaryToMarkdown(view: HostView): string {
  const t = strings(view.settings.lang);
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# ${t.md.title(date)}`, ""];
  const rounds = view.summary ?? [];

  const lash = rounds.find((r) => r.kind === "lastlash");
  if (lash?.lashAnswers?.length) {
    lines.push(`## ${t.md.actionItems}`, "", `_${lash.lashPrompt}_`, "");
    for (const a of lash.lashAnswers) {
      const owners = a.owners?.length ? ` — ${t.md.owner}: ${a.owners.map((o) => o.name).join(", ")}` : "";
      const by = a.author ? ` (${t.md.idea}: ${a.author})` : "";
      lines.push(`- [ ] ${a.text} (${t.md.votes(a.votes ?? 0)})${owners}${by}`);
    }
    lines.push("");
  }

  const followup = rounds.find((r) => r.kind === "followup")?.followupItems;
  if (followup?.length) {
    lines.push(`## ${t.md.lastRetro}`, "");
    for (const f of followup) {
      const tally = FOLLOWUP_OPTIONS.map((o, i) => `${o.emoji} ${f.counts[i] ?? 0}`).join(" · ");
      lines.push(`- ${f.text}: ${tally}`);
    }
    lines.push("");
  }

  const mood = rounds.find((r) => r.kind === "checkin")?.moodCounts;
  if (mood) {
    lines.push(`## ${t.md.weather}`, "", MOODS.map((m, i) => `${m.emoji} ${t.moods[i]}: ${mood[i] ?? 0}`).join(" · "), "");
  }

  const kudos = rounds.find((r) => r.kind === "kudos")?.kudos;
  if (kudos?.length) {
    lines.push(`## ${t.md.kudos}`, "");
    for (const k of kudos) lines.push(`- **${k.to ?? t.md.toTeam}**: ${k.text}`);
    lines.push("");
  }

  for (const r of rounds) {
    if (r.matchups.length === 0) continue;
    lines.push(`## ${r.title}`, "");
    for (const m of r.matchups) {
      lines.push(`**${m.prompt}**`, "");
      m.answers.forEach((a, i) => {
        if (!a) return;
        const by = m.authors ? ` — ${m.authors[i]}` : "";
        const auto = m.auto?.[i] ? ` (${t.md.auto})` : "";
        lines.push(`- ${a}${auto} (${t.md.votes(m.votes?.[i] ?? 0)})${by}`);
      });
      lines.push("");
    }
  }

  const players = view.players.filter((p) => !p.audience);
  if (!view.settings.anonymous && players.length) {
    lines.push(`## ${t.md.scores}`, "");
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const place = places(sorted.map((p) => p.score));
    // Shared places read "1. A", "1. B", "3. C". A numbered Markdown list would renumber
    // them, so it's a bullet list with the dot escaped.
    sorted.forEach((p, i) => lines.push(`- ${place[i]}\\. ${p.name} — ${p.score}`));
    lines.push("");
  }
  return lines.join("\n");
}
