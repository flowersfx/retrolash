// Landing-page illustrations, drawn in the theme's colours (CSS variables), so
// they follow Studio and Party. Decorative only.
import type { CSSProperties, ReactNode } from "react";

const f = (v: string): CSSProperties => ({ fill: `var(${v})` });
const s = (v: string, w = 3): CSSProperties => ({ stroke: `var(${v})`, strokeWidth: w, fill: "none" });

function Art({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg className="home-art" viewBox="0 0 280 190" role="img" aria-label={label}>
      {children}
    </svg>
  );
}

/** Confetti bits around the edges. */
function Confetti({ bits }: { bits: [number, number, number, string][] }) {
  return (
    <g className="art-confetti">
      {bits.map(([x, y, r, c], i) => (
        <rect key={i} x={x} y={y} width="9" height="4" rx="1.5" style={f(c)} transform={`rotate(${r} ${x + 4} ${y + 2})`} />
      ))}
    </g>
  );
}

/** A meeting-room screen mid-matchup: prompt, two cards, VS, voters' plates, a trophy. */
export function BigScreenArt() {
  return (
    <Art label="A big screen showing two answers head to head">
      <ellipse cx="140" cy="178" rx="96" ry="7" style={{ fill: "rgba(0,0,0,0.3)" }} />
      <rect x="120" y="150" width="40" height="18" rx="3" style={f("--panel-2")} />
      <rect x="92" y="166" width="96" height="7" rx="3.5" style={f("--panel-2")} />
      <rect x="18" y="10" width="244" height="146" rx="16" style={{ ...f("--bg"), ...s("--panel-2", 5), fill: "var(--bg)" }} />
      <rect x="28" y="20" width="224" height="126" rx="9" style={f("--bg-2")} />
      {/* prompt */}
      <rect x="78" y="32" width="124" height="9" rx="4.5" style={{ ...f("--ink"), opacity: 0.85 }} />
      <rect x="100" y="46" width="80" height="6" rx="3" style={{ ...f("--muted"), opacity: 0.6 }} />
      {/* cards */}
      <g className="art-card-l">
        <rect x="40" y="62" width="86" height="54" rx="9" style={f("--a")} transform="rotate(-4 83 89)" />
        <rect x="50" y="76" width="56" height="7" rx="3.5" style={{ fill: "rgba(0,0,0,0.45)" }} transform="rotate(-4 83 89)" />
        <rect x="50" y="88" width="38" height="7" rx="3.5" style={{ fill: "rgba(0,0,0,0.3)" }} transform="rotate(-4 83 89)" />
      </g>
      <g className="art-card-r">
        <rect x="154" y="62" width="86" height="54" rx="9" style={f("--b")} transform="rotate(4 197 89)" />
        <rect x="164" y="76" width="60" height="7" rx="3.5" style={{ fill: "rgba(0,0,0,0.45)" }} transform="rotate(4 197 89)" />
        <rect x="164" y="88" width="42" height="7" rx="3.5" style={{ fill: "rgba(0,0,0,0.3)" }} transform="rotate(4 197 89)" />
      </g>
      <circle cx="140" cy="90" r="13" style={{ ...f("--bg"), ...s("--panel-2", 3), fill: "var(--bg)" }} />
      <text x="140" y="94" textAnchor="middle" className="art-vs">
        VS
      </text>
      {/* voters' plates landing on the right card */}
      <rect x="160" y="122" width="30" height="11" rx="5.5" style={f("--c")} />
      <rect x="194" y="122" width="26" height="11" rx="5.5" style={f("--d")} />
      <rect x="224" y="122" width="20" height="11" rx="5.5" style={{ fill: "#ff8a3d" }} />
      <rect x="48" y="122" width="28" height="11" rx="5.5" style={{ fill: "#9be15d" }} />
      {/* trophy */}
      <g className="art-trophy" transform="translate(226 44)">
        <path d="M-9 -8 h18 v6 a9 9 0 0 1 -18 0z" style={f("--a")} />
        <rect x="-2.5" y="4" width="5" height="6" style={f("--a")} />
        <rect x="-7" y="10" width="14" height="4" rx="1.5" style={f("--a")} />
      </g>
      {/* corner QR */}
      <rect x="36" y="27" width="20" height="20" rx="3" style={{ fill: "#fff" }} />
      <rect x="39" y="30" width="6" height="6" style={{ fill: "#0f1524" }} />
      <rect x="47" y="38" width="6" height="6" style={{ fill: "#0f1524" }} />
      <rect x="39" y="40" width="4" height="4" style={{ fill: "#0f1524" }} />
      <Confetti
        bits={[
          [6, 30, 30, "--a"],
          [262, 22, -20, "--c"],
          [4, 120, -35, "--b"],
          [266, 110, 25, "--d"],
          [252, 160, 60, "--a"],
          [16, 160, 10, "--c"],
        ]}
      />
    </Art>
  );
}

/** A phone voting: prompt, three answers (one tapped), Neither, a +points bubble. */
export function PhoneArt() {
  return (
    <Art label="A phone with answers to vote on">
      <ellipse cx="140" cy="181" rx="56" ry="6" style={{ fill: "rgba(0,0,0,0.3)" }} />
      {/* signal to the big screen */}
      <g style={s("--d", 3)} strokeLinecap="round" className="art-signal">
        <path d="M78 66 a26 26 0 0 0 0 36" />
        <path d="M66 56 a40 40 0 0 0 0 56" opacity="0.6" />
        <path d="M54 46 a54 54 0 0 0 0 76" opacity="0.3" />
      </g>
      <rect x="96" y="6" width="88" height="170" rx="18" style={{ ...s("--panel-2", 5), fill: "var(--bg)" }} />
      <rect x="103" y="14" width="74" height="154" rx="12" style={f("--bg-2")} />
      <rect x="128" y="18" width="24" height="5" rx="2.5" style={f("--panel-2")} />
      {/* header: my plate and the timer */}
      <rect x="110" y="30" width="36" height="10" rx="5" style={f("--c")} />
      <circle cx="164" cy="35" r="6.5" style={s("--c", 2.5)} />
      {/* prompt */}
      <rect x="111" y="50" width="58" height="6" rx="3" style={{ ...f("--ink"), opacity: 0.85 }} />
      <rect x="111" y="60" width="40" height="5" rx="2.5" style={{ ...f("--ink"), opacity: 0.5 }} />
      {/* answers */}
      <rect x="110" y="74" width="60" height="21" rx="6" style={{ ...f("--a"), opacity: 0.55 }} />
      <rect x="110" y="100" width="60" height="21" rx="6" style={{ ...f("--b"), stroke: "var(--ink)", strokeWidth: 2.5 }} />
      <rect x="110" y="126" width="60" height="21" rx="6" style={{ ...f("--c"), opacity: 0.55 }} />
      <rect x="117" y="81" width="34" height="5" rx="2.5" style={{ fill: "rgba(0,0,0,0.35)" }} />
      <rect x="117" y="107" width="40" height="5" rx="2.5" style={{ fill: "rgba(0,0,0,0.45)" }} />
      <rect x="117" y="133" width="30" height="5" rx="2.5" style={{ fill: "rgba(0,0,0,0.35)" }} />
      <rect x="121" y="153" width="38" height="8" rx="4" style={s("--panel-2", 1.5)} />
      {/* the tap */}
      <g className="art-tap" style={s("--ink", 2)}>
        <circle cx="156" cy="111" r="8" opacity="0.55" />
        <circle cx="156" cy="111" r="14" opacity="0.25" />
      </g>
      {/* points and a reaction bubble */}
      <g className="art-points">
        <rect x="196" y="78" width="54" height="24" rx="12" style={f("--c")} />
        <text x="223" y="95" textAnchor="middle" className="art-pts">
          +300
        </text>
      </g>
      <g className="art-heart" transform="translate(214 44)">
        <circle r="13" style={f("--panel-2")} />
        <path d="M0 6 C-10 -1 -7 -9 0 -4 C7 -9 10 -1 0 6z" style={f("--b")} />
      </g>
      <Confetti
        bits={[
          [196, 130, 30, "--a"],
          [238, 140, -25, "--b"],
          [230, 20, 15, "--d"],
          [40, 150, -30, "--c"],
          [30, 20, 40, "--a"],
        ]}
      />
    </Art>
  );
}
