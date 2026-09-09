// ANSI-aware width/truncation helpers shared by decision and interview dialogs.

import { charWidth } from "./types.js";

export { charWidth };

export function visibleWidth(value: string): number {
  let width = 0;
  for (const part of ansiAwareParts(value)) {
    if (part.ansi) {
      continue;
    }
    for (const char of part.text) {
      width += charWidth(char);
    }
  }
  return width;
}

export function truncateStyledLine(value: string, width: number): string {
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return sliceStyledLine(value, width).text;
  }
  return `${sliceStyledLine(value, width - 1).text}…${resetAnsi(value)}`;
}

export function wrapStyledLine(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const results: string[] = [];
  let remaining = value;
  while (visibleWidth(remaining) > width) {
    const sliced = sliceStyledLine(remaining, width);
    results.push(`${sliced.text}${resetAnsi(remaining)}`);
    remaining = sliced.remaining;
  }
  results.push(remaining);
  return results;
}

function sliceStyledLine(value: string, maxWidth: number): { text: string; remaining: string } {
  let width = 0;
  let index = 0;
  for (const part of ansiAwareParts(value)) {
    if (part.ansi) {
      index += part.text.length;
      continue;
    }
    for (const char of part.text) {
      const nextWidth = width + charWidth(char);
      if (nextWidth > maxWidth) {
        return { text: value.slice(0, index), remaining: value.slice(index) };
      }
      width = nextWidth;
      index += char.length;
    }
  }
  return { text: value, remaining: "" };
}

function ansiAwareParts(value: string): Array<{ text: string; ansi: boolean }> {
  const parts: Array<{ text: string; ansi: boolean }> = [];
  const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  let lastIndex = 0;
  for (const match of value.matchAll(ansiPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, index), ansi: false });
    }
    parts.push({ text: match[0], ansi: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex), ansi: false });
  }
  return parts;
}

function resetAnsi(value: string): string {
  return /\u001b\[[0-?]*[ -/]*m/.test(value) ? "\u001b[0m" : "";
}
