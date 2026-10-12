import { useEffect, useMemo, useState } from "react";
import { formatDuration } from "../lib/format";

const FRAME_SETS = [
  ["✜", "✢", "✚", "✖", "✚", "✢"],
  ["·", "✦", "★", "✵", "✹", "✵", "★", "✦"],
  ["◦", "◯", "⦿", "◉", "⦿", "◯"],
  ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ["➔", "➘", "⬇", "↙", "⬅", "↖", "⬆", "↗"],
  ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  ["_", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", " "],
];

const VERBS = [
  "Revving",
  "Boosting",
  "Spooling",
  "Shifting gears",
  "Idling up",
  "Flooring it",
  "Spinning up",
  "Charging",
  // Funny & Chaotic
  "Wrangling electrons",
  "Persuading the server",
  "Slapping the engine",
  "Bribing the CPU",
  "Counting backwards from infinity",
  "Untangling the cables",
  "Hoping for the best",
  "Aggressively downloading internet",
  "Screaming into the void",
  "Polishing the pixels",
  "Turning it off and on again",
  "Feeding the code hamsters",
  // Made-up / Nonsense Words
  "PSOperator-blastering",
  "Giga-snortling",
  "Splunking the mainframe",
  "Flabbergasting data",
  "Confabulating digits",
  "Bamboozling the cache",
  "Discombobulating vectors",
  "Frobnitzing bits",
  "Splurgifying buffers",
  "Sprocketing along",
];

export function Spinner({ since }: { since: number }) {
  const [tick, setTick] = useState(0);

  const frames = useMemo(
    () => FRAME_SETS[Math.floor(Math.random() * FRAME_SETS.length)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [since],
  );

  const verb = useMemo(
    () => VERBS[Math.floor(Math.random() * VERBS.length)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [since],
  );

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 110);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="spinner">
      <span className="spinner-glyph">{frames[tick % frames.length]}</span>
      <span className="spinner-verb">{verb}…</span>
      <span className="dim">
        {" "}
        ({formatDuration(Date.now() - since)} · esc to interrupt)
      </span>
    </div>
  );
}
