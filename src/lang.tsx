// Client-side language context, plus labels shared by the big screen and VIP phones.
import { createContext, useContext, useEffect } from "react";
import { strings, type Strings } from "../shared/i18n";
import { prompts, type PromptSet } from "../shared/prompts";
import { DEFAULT_SETTINGS, type Lang, type Phase, type ThemeId } from "../shared/types";

export const LangContext = createContext<Lang>("en");
export const useT = (): Strings => strings(useContext(LangContext));
export const usePrompts = (): PromptSet => prompts(useContext(LangContext));

/** Phone language before the room tells us: Swedish if the phone is Swedish. */
export function deviceLang(): Lang {
  return typeof navigator !== "undefined" && /^sv\b/i.test(navigator.language) ? "sv" : "en";
}

/** What "next" does right now, for the big-screen button and the VIP remote. */
export function nextLabel(
  t: Strings,
  v: {
    phase: Phase;
    roundNumber: number;
    roundCount: number;
    matchupNumber?: number;
    matchupCount?: number;
    anonymous: boolean;
  },
) {
  switch (v.phase) {
    case "answering":
    case "voting":
    case "lashVoting":
      return t.next.skipTimer;
    case "matchupIntro":
      return t.next.startVoting;
    case "matchupResult":
      return v.matchupNumber === v.matchupCount ? t.next.finishRound : t.next.nextMatchup;
    case "roundResult":
    case "pollResult":
    case "lashResult":
      if (v.roundNumber < v.roundCount) return t.next.nextRound;
      return t.next.finishGame;
    case "highlights":
      return v.anonymous ? t.next.showSummary : t.next.showPodium;
    case "podium":
      return t.next.showSummary;
    default:
      return t.next.next;
  }
}

/** Put the room's look on the page (CSS keys off html[data-theme]). */
export function useTheme(theme: ThemeId | undefined) {
  useEffect(() => {
    const t = theme ?? DEFAULT_SETTINGS.theme;
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "party" ? "#1a1033" : "#0f1524");
  }, [theme]);
}

export const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
