const FILLER_PREFIX = /^(please|pls|can you|could you|would you|i need you to|help me|factory)\s+/i;
const TRAILING_DETAIL = /\b(using|with|without|where|when|while|because|so that|and make sure|but do not|don't|dont|please)\b/i;
const FILLER_WORDS = new Set(["a", "an", "the", "to", "for", "me"]);

export function smartRunTitle(goal: string): string {
  let title = goal
    .replace(/\/factory\b/gi, " ")
    .replace(/--?[a-z][\w-]*(?:=\S+)?/gi, " ")
    .replace(/[@./~][^\s]+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  while (FILLER_PREFIX.test(title)) {
    title = title.replace(FILLER_PREFIX, "").trim();
  }

  const detail = title.search(TRAILING_DETAIL);
  if (detail > 12) {
    title = title.slice(0, detail).trim();
  }

  const words = title.split(/\s+/).filter((word) => word && !FILLER_WORDS.has(word.toLowerCase())).slice(0, 7);
  title = words.join(" ");

  if (!title) {
    return "Untitled run";
  }
  if (title.length <= 60) {
    return title;
  }
  return `${title.slice(0, 57).trimEnd()}...`;
}
