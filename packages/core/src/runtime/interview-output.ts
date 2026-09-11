/** Keep model instructions and transcript noise out of user-facing interviews. */
export function normalizeInterviewOutput(output: string): string | undefined {
  if (/^Role:\s*Interview\b/im.test(output) && /Format a round like this:/i.test(output)) {
    return undefined;
  }
  const lines = output.split(/\r?\n/);
  const firstQuestion = lines.findIndex((line) => /^\s*Q\d+\s*[-:.–—]\s*\S+/i.test(line) && !/[<{][^>]*>/.test(line));
  if (firstQuestion < 0) return undefined;
  const round: string[] = [];
  let previousNumber = 0;
  for (const line of lines.slice(firstQuestion)) {
    const marker = /^\s*Q(\d+)\s*[-:.–—]\s*\S+/i.exec(line);
    if (marker) {
      const number = Number(marker[1]);
      if (number <= previousNumber) break;
      previousNumber = number;
    }
    round.push(line);
  }
  while (round.at(-1)?.trim().match(/^---+$/)) round.pop();
  return round.join("\n").trim() || undefined;
}
