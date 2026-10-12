export interface TextBlock {
  type: "text";
  text: string;
}

export interface TableBlock {
  type: "table";
  headers: string[];
  rows: string[][];
  raw: string;
}

export interface LogRecord {
  time: string;
  level: string;
  source: string;
  message: string;
  raw: string;
}

export interface LogsBlock {
  type: "logs";
  records: LogRecord[];
  raw: string;
}

export interface JsonBlock {
  type: "json";
  raw: string;
  value: unknown;
}

export interface WeatherPeriod {
  name: string;
  condition: string;
  temperature: string;
  wind: string;
  visibility: string;
  precipitation: string;
  chance: string;
}

export interface WeatherDay {
  date: string;
  periods: WeatherPeriod[];
}

export interface WeatherBlock {
  type: "weather";
  location: string;
  current: WeatherPeriod;
  days: WeatherDay[];
  raw: string;
}

export type OutputBlock = TextBlock | TableBlock | LogsBlock | JsonBlock | WeatherBlock;

const WEATHER_CONDITIONS = [
  "Patchy rain nearby", "Moderate rain", "Heavy rain", "Light rain", "Patchy rain", "Rain showers",
  "Patchy snow", "Light snow", "Heavy snow", "Thunderstorm", "Thundery outbreaks", "Overcast",
  "Partly cloudy", "Mostly cloudy", "Cloudy", "Clear", "Sunny", "Mist", "Fog", "Drizzle", "Windy",
];

function weatherPeriod(name: string, text: string): WeatherPeriod {
  const find = (pattern: RegExp) => pattern.exec(text)?.[0]?.replace(/\s+/g, " ").trim() ?? "";
  const condition = WEATHER_CONDITIONS.find((item) => new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) ?? "";
  return {
    name,
    condition,
    temperature: find(/[+−-]?\d{1,2}(?:\(\d{1,2}\))?\s*°\s*C/i),
    wind: find(/[←↖↑↗→↘↓↙]?\s*\d+(?:[–-]\d+)?\s*km\s*\/\s*h/i),
    visibility: find(/\b\d+(?:\.\d+)?\s*km\b/i),
    precipitation: find(/\b\d+(?:\.\d+)?\s*mm\b/i),
    chance: find(/\b\d{1,3}%\b/),
  };
}

// eslint-disable-next-line no-control-regex
function stripWeatherAnsi(text: string) {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isWeatherRule(line: string) {
  return /[─━═]{3}/.test(line) && !/[A-Za-z0-9]/.test(line.replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w+\b/i, ""));
}

function cellsInWeatherRow(line: string, count: number): string[] {
  const cells = line.split("│");
  if (cells.length >= count + 2) return cells.slice(1, count + 1);
  return Array.from({ length: count }, (_, index) => cells[index] ?? "");
}

function parseWeather(text: string): WeatherBlock | null {
  if (!/Weather report\s*:/i.test(text)) return null;
  const plain = stripWeatherAnsi(text);
  const lines = plain.split("\n");
  const titleIndex = lines.findIndex((line) => /Weather report\s*:/i.test(line));
  const title = /Weather report\s*:\s*(.*)/i.exec(lines[titleIndex] ?? "")?.[1]?.trim() ?? "";
  const headerIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /\bMorning\b/i.test(line) && /\bNoon\b/i.test(line) && /\bEvening\b/i.test(line) && /\bNight\b/i.test(line));
  if (!title || headerIndexes.length === 0) return null;

  const periodNames = ["Morning", "Noon", "Evening", "Night"];
  const datePattern = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Za-z]{3}\b/i;
  const days: WeatherDay[] = [];
  for (const { index: headerIndex } of headerIndexes) {
    let date = "";
    for (let i = Math.max(titleIndex + 1, headerIndex - 4); i < headerIndex; i += 1) {
      date = datePattern.exec(lines[i])?.[0] ?? date;
    }
    let dataStart = headerIndex + 1;
    while (dataStart < lines.length && isWeatherRule(lines[dataStart])) dataStart += 1;
    const cellLines = periodNames.map(() => [] as string[]);
    for (let i = dataStart; i < lines.length && !isWeatherRule(lines[i]); i += 1) {
      const rowCells = cellsInWeatherRow(lines[i], periodNames.length);
      rowCells.forEach((cell, cellIndex) => cellLines[cellIndex].push(cell));
    }
    const periods = periodNames.map((name, cellIndex) => weatherPeriod(name, cellLines[cellIndex].join("\n")));
    if (periods.some((period) => period.condition || period.temperature)) days.push({ date, periods });
  }

  const firstReportSection = lines.slice(titleIndex + 1, headerIndexes[0].index).join("\n");
  const current = weatherPeriod("Current", firstReportSection);
  if (!current.condition && !current.temperature) return null;
  return { type: "weather", location: title, current, days, raw: text };
}

function separatorColumns(line: string): number[] | null {
  const matches = [...line.matchAll(/-{2,}/g)];
  if (matches.length < 2 || matches.length > 12) return null;

  let previousEnd = 0;
  for (const match of matches) {
    const gap = line.slice(previousEnd, match.index);
    if (!/^[\t ]*$/.test(gap) || (previousEnd > 0 && gap.length < 1)) return null;
    previousEnd = match.index! + match[0].length;
  }
  if (!/^[\t ]*$/.test(line.slice(previousEnd))) return null;
  return matches.map((match) => match.index!);
}

function cellsAt(line: string, starts: number[]): string[] {
  return starts.map((start, index) => line.slice(start, starts[index + 1] ?? undefined).trim());
}

const LEVELS = "TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL|SUCCESS|OK";
const LOG_LINE = new RegExp(
  `^\\s*(?:(\\[[^\\]]+\\]|\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?|\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)\\s+)?\\[\\s*(${LEVELS})\\s*\\]\\s*(.*)$`,
  "i",
);

function parseLogLine(raw: string): LogRecord | null {
  const match = LOG_LINE.exec(raw);
  if (!match) return null;
  const rest = match[3];
  const source = /^(\S+?):\s*(.*)$/.exec(rest);
  return {
    time: match[1] ?? "",
    level: match[2].toUpperCase().replace("WARNING", "WARN"),
    source: source?.[1] ?? "",
    message: source?.[2] ?? rest,
    raw,
  };
}

function findJson(lines: string[], start: number): { value: unknown; end: number } | null {
  const first = lines[start].trimStart();
  if (!first.startsWith("{") && !first.startsWith("[")) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let row = start; row < lines.length; row += 1) {
    const line = lines[row];
    for (let column = row === start ? line.length - first.length : 0; column < line.length; column += 1) {
      const char = line[column];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        const opener = stack.pop();
        if ((char === "}" && opener !== "{") || (char === "]" && opener !== "[")) return null;
        if (stack.length === 0) {
          if (line.slice(column + 1).trim()) return null;
          const raw = lines.slice(start, row + 1).join("\n");
          try {
            return { value: JSON.parse(raw), end: row };
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function parseTextBlocks(text: string): OutputBlock[] {
  const lines = text.split("\n");
  const blocks: OutputBlock[] = [];
  let textStart = 0;
  let index = 0;
  const pushText = (end: number) => {
    if (end > textStart) blocks.push({ type: "text", text: lines.slice(textStart, end).join("\n") });
  };

  while (index < lines.length) {
    const log = parseLogLine(lines[index]);
    if (log) {
      let end = index + 1;
      const records = [log];
      while (end < lines.length) {
        const next = parseLogLine(lines[end]);
        if (!next) break;
        records.push(next);
        end += 1;
      }
      pushText(index);
      blocks.push({ type: "logs", records, raw: records.map((record) => record.raw).join("\n") });
      textStart = end;
      index = end;
      continue;
    }

    if (index + 1 < lines.length) {
      const starts = separatorColumns(lines[index + 1]);
      if (starts) {
        const headers = cellsAt(lines[index], starts);
        if (headers.every((header) => header.length > 0 && header.length <= 80)) {
          let end = index + 2;
          while (end < lines.length && lines[end].trim()) end += 1;
          if (end > index + 2) {
            pushText(index);
            const rawLines = lines.slice(index, end);
            blocks.push({ type: "table", headers, rows: rawLines.slice(2).map((line) => cellsAt(line, starts)), raw: rawLines.join("\n") });
            textStart = end;
            index = end;
            continue;
          }
        }
      }
    }

    const json = findJson(lines, index);
    if (json) {
      pushText(index);
      blocks.push({ type: "json", raw: lines.slice(index, json.end + 1).join("\n"), value: json.value });
      textStart = json.end + 1;
      index = textStart;
      continue;
    }
    index += 1;
  }

  pushText(lines.length);
  return blocks;
}

/** Render only recognizable PowerShell tables, structured logs, and standalone JSON. */
export function parseOutputBlocks(text: string): OutputBlock[] {
  const weather = parseWeather(text);
  if (weather) return [weather];
  return parseTextBlocks(text);
}
