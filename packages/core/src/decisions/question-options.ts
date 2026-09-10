import type { DecisionOption } from "./types.js";

export interface ParsedInterviewQuestion {
  raw: string;
  prompt: string;
  options: DecisionOption[];
  recommendation?: string;
}

export function splitInterviewQuestions(value: string): string[] {
  const blocks = value
    // Markdown documents often contain horizontal rules. Only treat a rule
    // as a question separator when the following block starts a real round.
    .split(/\n\s*---+\s*\n(?=\s*(?:Q\d+\s*[-:.]|❓))/g)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.length > 0 ? blocks : [value.trim()].filter(Boolean);
}

export function parseInterviewQuestions(value: string): ParsedInterviewQuestion[] {
  return splitInterviewQuestions(value).map((raw) => parseInterviewQuestion(raw));
}

export function parseInterviewQuestion(raw: string): ParsedInterviewQuestion {
  const lines = raw.split(/\r?\n/);
  const questionLines: string[] = [];
  const optionLines: string[] = [];
  let recommendation: string | undefined;
  let inOptions = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inOptions && /^Options:\s*$/i.test(trimmed)) {
      inOptions = true;
      continue;
    }
    if (/^->\s+/.test(trimmed)) {
      recommendation = trimmed.replace(/^->\s+/, "").trim() || undefined;
      inOptions = false;
      continue;
    }
    if (inOptions) {
      if (!trimmed) {
        continue;
      }
      if (/^\[[A-Za-z0-9]+\]\s+/.test(trimmed)) {
        optionLines.push(trimmed);
        continue;
      }
      questionLines.push(line);
      inOptions = false;
      continue;
    }
    questionLines.push(line);
  }

  return {
    raw: raw.trim(),
    prompt: questionLines.join("\n").trim(),
    options: parseOptionLines(optionLines),
    recommendation,
  };
}

function parseOptionLines(lines: string[]): DecisionOption[] {
  return lines.map((line, index) => {
    const match = /^\[([A-Za-z0-9]+)\]\s+(.+)$/.exec(line.trim());
    if (!match) {
      return undefined;
    }
    const marker = match[1]!.toLowerCase();
    const rest = match[2]!.trim();
    const parts = rest.split(/\s+—\s+|\s+-\s+/);
    const label = parts[0]?.trim();
    if (!label) {
      return undefined;
    }
    const description = parts.slice(1).join(" — ").trim() || undefined;
    return {
      id: marker || `option-${index + 1}`,
      label,
      ...(description ? { description } : {}),
    };
  }).filter((value): value is DecisionOption => Boolean(value));
}
