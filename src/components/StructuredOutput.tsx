import { useState } from "react";
import type { JsonBlock, LogsBlock, WeatherBlock, WeatherPeriod } from "../lib/table";

const LEVEL_CLASS: Record<string, string> = {
  TRACE: "debug",
  DEBUG: "debug",
  INFO: "info",
  NOTICE: "notice",
  WARN: "warn",
  ERROR: "error",
  FATAL: "error",
  CRITICAL: "error",
  SUCCESS: "success",
  OK: "success",
};

export function LogsOutput({ block }: { block: LogsBlock }) {
  const [filter, setFilter] = useState<string[]>([]);
  const levels = [...new Set(block.records.map((record) => record.level))];
  const visible = filter.length ? block.records.filter((record) => filter.includes(record.level)) : block.records;

  const toggle = (level: string) => {
    setFilter((current) => {
      const next = current.length ? current : [level];
      if (!current.length) return next;
      const updated = next.includes(level) ? next.filter((item) => item !== level) : [...next, level];
      return updated.length === levels.length ? [] : updated;
    });
  };

  return (
    <section className="structured-logs" aria-label="Structured log output">
      <div className="log-filters" aria-label="Filter log levels">
        <button className={!filter.length ? "selected" : ""} onClick={() => setFilter([])}>All</button>
        {levels.map((level) => (
          <button key={level} className={!filter.length || filter.includes(level) ? "selected" : ""} onClick={() => toggle(level)}>
            {level}
          </button>
        ))}
        <span className="log-count">{visible.length}/{block.records.length}</span>
      </div>
      <div className="log-table-scroll">
        <table className="log-table">
          <thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr></thead>
          <tbody>{visible.map((record, index) => (
            <tr key={`${index}-${record.raw}`}>
              <td className="log-time">{record.time || "—"}</td>
              <td><span className={`log-badge log-level-${LEVEL_CLASS[record.level] ?? "info"}`}>{record.level}</span></td>
              <td className="log-source">{record.source || "—"}</td>
              <td className="log-message">{record.message}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <details className="table-raw"><summary>Raw output</summary><pre className="seg">{block.raw}</pre></details>
    </section>
  );
}

function weatherGlyph(condition: string) {
  const value = condition.toLowerCase();
  if (/thunder|storm/.test(value)) return "ϟ";
  if (/snow|sleet|ice/.test(value)) return "❄";
  if (/rain|drizzle|shower/.test(value)) return "☂";
  if (/overcast|cloud|mist|fog/.test(value)) return "☁";
  return "☀";
}

function WeatherMetrics({ period }: { period: WeatherPeriod }) {
  return (
    <div className="weather-metrics">
      {period.temperature && <strong className="weather-temperature">{period.temperature}</strong>}
      {period.wind && <span><i>Wind</i>{period.wind}</span>}
      {period.visibility && <span><i>Visibility</i>{period.visibility}</span>}
      {period.precipitation && <span><i>Precip.</i>{period.precipitation}{period.chance ? ` · ${period.chance}` : ""}</span>}
    </div>
  );
}

export function WeatherOutput({ block }: { block: WeatherBlock }) {
  return (
    <section className="weather-report" aria-label="Weather report">
      <header className="weather-report-header">
        <span className="weather-report-mark">◉</span>
        <div><strong>Weather</strong><span>{block.location}</span></div>
        {block.current.condition && <span className="weather-updated">CURRENT CONDITIONS</span>}
      </header>
      <div className="weather-current">
        <span className="weather-glyph">{weatherGlyph(block.current.condition)}</span>
        <div className="weather-current-copy">
          <strong>{block.current.condition || "Current conditions"}</strong>
          <WeatherMetrics period={block.current} />
        </div>
      </div>
      {block.days.length > 0 && (
        <div className="weather-days">
          {block.days.map((day, dayIndex) => (
            <section className="weather-day" key={`${day.date}-${dayIndex}`}>
              <h3>{day.date || `Forecast ${dayIndex + 1}`}</h3>
              <div className="weather-periods">
                {day.periods.map((period) => (
                  <article className="weather-period" key={period.name}>
                    <span className="weather-period-name">{period.name}</span>
                    <span className="weather-period-glyph">{weatherGlyph(period.condition)}</span>
                    <strong className="weather-condition" title={period.condition}>{period.condition || "—"}</strong>
                    <WeatherMetrics period={period} />
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <details className="table-raw weather-raw"><summary>Raw output</summary><pre className="seg">{block.raw}</pre></details>
    </section>
  );
}

function JsonValue({ value, label, root = false }: { value: unknown; label?: string; root?: boolean }) {
  const prefix = label === undefined ? null : <span className="json-key">{JSON.stringify(label)}: </span>;
  if (value === null) return <div className="json-node">{prefix}<span className="json-null">null</span></div>;
  if (typeof value === "string") return <div className="json-node">{prefix}<span className="json-string">{JSON.stringify(value)}</span></div>;
  if (typeof value === "number") return <div className="json-node">{prefix}<span className="json-number">{value}</span></div>;
  if (typeof value === "boolean") return <div className="json-node">{prefix}<span className="json-boolean">{String(value)}</span></div>;

  if (Array.isArray(value)) {
    return (
      <details className="json-branch" open={root}>
        <summary>{prefix}<span className="json-bracket">Array</span><span className="dim"> · {value.length}</span></summary>
        <div className="json-children">{value.map((child, index) => <JsonValue key={index} label={String(index)} value={child} />)}</div>
      </details>
    );
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return (
    <details className="json-branch" open={root}>
      <summary>{prefix}<span className="json-bracket">Object</span><span className="dim"> · {keys.length}</span></summary>
      <div className="json-children">{keys.map((key) => <JsonValue key={key} label={key} value={object[key]} />)}</div>
    </details>
  );
}

export function JsonOutput({ block }: { block: JsonBlock }) {
  const [view, setView] = useState<"tree" | "formatted" | "raw">("tree");
  const [copyState, setCopyState] = useState("Copy");
  const formatted = JSON.stringify(block.value, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.raw);
      setCopyState("Copied");
      window.setTimeout(() => setCopyState("Copy"), 1400);
    } catch {
      setCopyState("Copy unavailable");
      window.setTimeout(() => setCopyState("Copy"), 1800);
    }
  };

  return (
    <section className="structured-json" aria-label="JSON output">
      <div className="json-toolbar">
        <div className="json-views">
          {(["tree", "formatted", "raw"] as const).map((item) => (
            <button key={item} className={view === item ? "selected" : ""} onClick={() => setView(item)}>
              {item === "tree" ? "Tree" : item === "formatted" ? "Formatted" : "Raw"}
            </button>
          ))}
        </div>
        <button onClick={() => void copy()}>{copyState}</button>
      </div>
      <div className="json-content">
        {view === "tree" ? <JsonValue value={block.value} root /> : (
          <pre className="json-code">{view === "formatted" ? formatted : block.raw}</pre>
        )}
      </div>
    </section>
  );
}
