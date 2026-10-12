import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Game = "tiles" | "reaction" | "simon" | "snake";

const games: { id: Game; name: string; description: string }[] = [
  { id: "tiles", name: "Number Slide", description: "Put the tiles in order. Click a tile beside the empty space." },
  { id: "reaction", name: "Reaction Tap", description: "Tap the target as soon as it appears." },
  { id: "simon", name: "Memory Sequence", description: "Repeat the growing sequence of colors." },
  { id: "snake", name: "Snake", description: "Collect dots and avoid the walls and your tail." },
];
const COLORS = ["coral", "gold", "mint", "blue"] as const;
type Point = { x: number; y: number };
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function shuffledTiles() {
  const values = Array.from({ length: 15 }, (_, index) => index + 1);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  values.push(0);
  return values;
}

export function WaitingArcade({ onClose }: { onClose: () => void }) {
  const [game, setGame] = useState<Game>("tiles");
  const [tiles, setTiles] = useState(shuffledTiles);
  const [position, setPosition] = useState(() => ({ x: Math.max(18, window.innerWidth - 340), y: 72 }));
  const [collapsed, setCollapsed] = useState(false);
  const [moves, setMoves] = useState(0);
  const [reaction, setReaction] = useState<"ready" | "waiting" | "go" | "tooSoon">("ready");
  const [reactionMs, setReactionMs] = useState<number | null>(null);
  const [sequence, setSequence] = useState<number[]>([]);
  const [sequenceInput, setSequenceInput] = useState<number[]>([]);
  const [sequenceFlash, setSequenceFlash] = useState<number | null>(null);
  const [sequenceMessage, setSequenceMessage] = useState("Press Start to play");
  const [snake, setSnake] = useState<Point[]>([{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]);
  const [food, setFood] = useState<Point>({ x: 8, y: 5 });
  const [direction, setDirection] = useState<Point>({ x: 1, y: 0 });
  const [snakeRunning, setSnakeRunning] = useState(false);
  const [snakeScore, setSnakeScore] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const startedAt = useRef(0);

  const sequenceTimers = useRef<number[]>([]);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    sequenceTimers.current.forEach(window.clearTimeout);
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const move = (pointer: PointerEvent) => setPosition({
      x: Math.min(window.innerWidth - 280, Math.max(0, origin.x + pointer.clientX - startX)),
      y: Math.min(window.innerHeight - 80, Math.max(34, origin.y + pointer.clientY - startY)),
    });
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  const resetTiles = () => { setTiles(shuffledTiles()); setMoves(0); };
  const moveTile = (index: number) => {
    const empty = tiles.indexOf(0);
    if (![empty - 4, empty + 4, ...(empty % 4 ? [empty - 1] : []), ...(empty % 4 < 3 ? [empty + 1] : [])].includes(index)) return;
    setTiles((current) => {
      const next = [...current];
      [next[index], next[empty]] = [next[empty], next[index]];
      return next;
    });
    setMoves((count) => count + 1);
  };
  const startReaction = () => {
    window.clearTimeout(timer.current);
    setReaction("waiting");
    setReactionMs(null);
    timer.current = window.setTimeout(() => {
      startedAt.current = performance.now();
      setReaction("go");
    }, 700 + Math.random() * 2200);
  };
  const tapReaction = () => {
    if (reaction === "ready" || reaction === "tooSoon") startReaction();
    else if (reaction === "waiting") { window.clearTimeout(timer.current); setReaction("tooSoon"); }
    else { setReactionMs(Math.round(performance.now() - startedAt.current)); setReaction("ready"); }
  };

  const startSequence = () => {
    sequenceTimers.current.forEach(window.clearTimeout);
    const next = [Math.floor(Math.random() * 4)];
    setSequence(next);
    setSequenceInput([]);
    setSequenceMessage("Watch the sequence");
    next.forEach((color, index) => {
      sequenceTimers.current.push(window.setTimeout(() => setSequenceFlash(color), 450 + index * 700));
      sequenceTimers.current.push(window.setTimeout(() => setSequenceFlash(null), 850 + index * 700));
    });
    sequenceTimers.current.push(window.setTimeout(() => setSequenceMessage("Your turn"), 450 + next.length * 700));
  };
  const tapSequence = (color: number) => {
    if (sequenceFlash !== null || !sequence.length || sequenceMessage !== "Your turn") return;
    const nextInput = [...sequenceInput, color];
    setSequenceInput(nextInput);
    if (sequence[nextInput.length - 1] !== color) {
      setSequenceMessage(`Game over · ${sequence.length - 1} points`);
      setSequence([]);
      return;
    }
    if (nextInput.length === sequence.length) {
      const next = [...sequence, Math.floor(Math.random() * 4)];
      setSequence(next);
      setSequenceInput([]);
      setSequenceMessage("Watch the sequence");
      next.forEach((item, index) => {
        sequenceTimers.current.push(window.setTimeout(() => setSequenceFlash(item), 450 + index * 700));
        sequenceTimers.current.push(window.setTimeout(() => setSequenceFlash(null), 850 + index * 700));
      });
      sequenceTimers.current.push(window.setTimeout(() => setSequenceMessage("Your turn"), 450 + next.length * 700));
    }
  };

  const resetSnake = () => {
    setSnake([{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]);
    setFood({ x: 8, y: 5 });
    setDirection({ x: 1, y: 0 });
    setSnakeScore(0);
    setSnakeRunning(true);
  };
  useEffect(() => {
    if (!snakeRunning || game !== "snake") return;
    const tick = window.setInterval(() => {
      setSnake((current) => {
        const head = { x: current[0].x + direction.x, y: current[0].y + direction.y };
        const eating = samePoint(head, food);
        if (head.x < 0 || head.x >= 12 || head.y < 0 || head.y >= 10 || current.slice(0, eating ? undefined : -1).some((point) => samePoint(point, head))) {
          setSnakeRunning(false);
          return current;
        }
        const next = [head, ...current.slice(0, eating ? undefined : -1)];
        if (eating) {
          setSnakeScore((score) => score + 1);
          let nextFood: Point;
          do { nextFood = { x: Math.floor(Math.random() * 12), y: Math.floor(Math.random() * 10) }; }
          while (next.some((point) => samePoint(point, nextFood)));
          setFood(nextFood);
        }
        return next;
      });
    }, 150);
    return () => window.clearInterval(tick);
  }, [snakeRunning, game, direction, food]);
  useEffect(() => {
    if (game !== "snake") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const keyDirections: Record<string, Point> = {
        ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
        ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 },
      };
      const next = keyDirections[event.key] ?? keyDirections[event.key.toLowerCase()];
      if (!next) return;
      event.preventDefault();
      steerSnake(next.x, next.y);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [game, direction]);
  const steerSnake = (x: number, y: number) => {
    if (x !== -direction.x || y !== -direction.y) setDirection({ x, y });
  };

  const won = tiles.every((value, index) => value === (index + 1) % 16);
  const currentGame = games.find((item) => item.id === game)!;

  return <section className="waiting-arcade" style={{ left: position.x, top: position.y }} aria-label="Waiting arcade" onDragStart={(event) => event.preventDefault()}>
    <header className="waiting-arcade-header" onPointerDown={beginDrag}>
      <div><span className="waiting-arcade-mark">✳</span><span>Waiting Arcade</span><span className="waiting-arcade-live">PROCESS RUNNING</span></div>
      <nav>
        <button title={collapsed ? "Expand" : "Collapse"} aria-label={collapsed ? "Expand arcade" : "Collapse arcade"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "＋" : "−"}</button>
        <button title="Close arcade" aria-label="Close arcade" onClick={onClose}>×</button>
      </nav>
    </header>
    {!collapsed && <div className="waiting-arcade-body">
      <div className="arcade-game-tabs" role="tablist" aria-label="Minigames">
        {games.map((item) => <button key={item.id} role="tab" aria-selected={game === item.id} className={game === item.id ? "selected" : ""} onClick={() => setGame(item.id)}>{item.name}</button>)}
      </div>
      <div className="arcade-game-heading"><strong>{currentGame.name}</strong><span>{currentGame.description}</span></div>
      {game === "tiles" && <>
        <div className="number-grid" aria-label="Number Slide puzzle">
          {tiles.map((value, index) => <button key={index} className={value ? "number-tile" : "number-tile empty"} onClick={() => moveTile(index)} aria-label={value ? `Move tile ${value}` : "Empty space"}>{value || ""}</button>)}
        </div>
        <div className="arcade-footer"><span>{won ? "Solved! Nice one." : `${moves} moves`}</span><button onClick={resetTiles}>Shuffle</button></div>
      </>}
      {game === "reaction" && <div className="reaction-game">
        <button className={`reaction-target ${reaction}`} onClick={tapReaction}>{reaction === "go" ? "TAP!" : reaction === "waiting" ? "Wait…" : reaction === "tooSoon" ? "Too soon · try again" : reactionMs ? `${reactionMs} ms · again?` : "Start reaction test"}</button>
      </div>}
      {game === "simon" && <>
        <div className="simon-board" aria-label="Memory Sequence game">
          {COLORS.map((color, index) => <button key={color} aria-label={`${color} button`} className={`simon-pad ${color}${sequenceFlash === index ? " lit" : ""}`} onClick={() => tapSequence(index)} />)}
        </div>
        <div className="arcade-footer"><span>{sequenceMessage}</span><button onClick={startSequence}>Start</button></div>
      </>}
      {game === "snake" && <>
        <div className="snake-board" role="img" aria-label={`Snake game, score ${snakeScore}`}>
          {Array.from({ length: 120 }, (_, index) => {
            const point = { x: index % 12, y: Math.floor(index / 12) };
            const isHead = samePoint(point, snake[0]);
            const isBody = snake.slice(1).some((part) => samePoint(part, point));
            return <span key={index} className={isHead ? "snake-head" : isBody ? "snake-body" : samePoint(point, food) ? "snake-food" : ""} />;
          })}
        </div>
        <div className="snake-controls" aria-label="Snake controls">
          <button onClick={() => steerSnake(0, -1)}>↑</button><div><button onClick={() => steerSnake(-1, 0)}>←</button><button onClick={() => steerSnake(0, 1)}>↓</button><button onClick={() => steerSnake(1, 0)}>→</button></div>
        </div>
        <div className="arcade-footer"><span>Score {snakeScore}{snakeRunning ? " · Playing" : snakeScore ? " · Game over" : ""}</span><button onClick={resetSnake}>{snakeRunning ? "Restart" : "Start"}</button></div>
      </>}
      <footer className="arcade-note"><span className="arcade-dot" />This game runs independently of your process</footer>
    </div>}
  </section>;
}
