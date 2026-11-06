import { useState } from "react";
import { normalizeCode } from "./net";

export default function Home({
  onHost,
  onJoin,
}: {
  onHost: () => void;
  onJoin: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  return (
    <main className="home">
      <h1 className="logo">
        Retro<span>lash</span>
      </h1>
      <p className="tagline">
        A party game for sprint retrospectives. One big screen, everyone's phones.
      </p>
      <div className="home-cards">
        <section className="card">
          <h2>📺 On the meeting-room screen</h2>
          <p>Start a room and put it on the big screen. Everyone joins with their phone.</p>
          <button className="btn big" onClick={onHost}>
            Host a retro
          </button>
        </section>
        <section className="card">
          <h2>📱 On your phone</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 4) onJoin(code);
            }}
          >
            <input
              className="code-input"
              placeholder="ROOM CODE"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
            />
            <button className="btn big" disabled={code.length !== 4}>
              Join
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
