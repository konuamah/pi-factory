const FILLER_PREFIX = /^(please|pls|can you|could you|would you|i need you to|help me|factory)\s+/i;
const TRAILING_DETAIL = /\b(using|with|without|where|when|while|because|so that|and make sure|but do not|don't|dont|please)\b/i;
const FILLER_WORDS = new Set(["a", "an", "the", "to", "for", "me"]);
const PROMPT_TEMPLATE_HEADING = /(^|\n)\s*#{1,3}\s*(planner mode|builder mode|lead software architect(?:\s*&\s*planner)?|implementation plan)\b/i;

export function taskObjectiveForPrompt(goal: string): string {
  return extractPromptTemplateTask(goal) ?? stripNestedPromptTemplate(goal) ?? goal.trim();
}

export function smartRunTitle(goal: string): string {
  let title = (extractPromptTemplateTask(goal) ?? stripNestedPromptTemplate(goal) ?? goal)
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

function extractPromptTemplateTask(goal: string): string | undefined {
  const marker = /your job for this task\s*[—-]\s*/i.exec(goal);
  if (!marker) return undefined;
  const afterMarker = goal.slice(marker.index + marker[0].length).trimStart();
  const captured = afterMarker.startsWith("**")
    ? afterMarker.slice(2, afterMarker.indexOf("**", 2) >= 0 ? afterMarker.indexOf("**", 2) : undefined)
    : afterMarker.split(/\s+[—-]\s+is\b/i)[0];
  return cleanupObjective(stripNestedPromptTemplate(captured) ?? captured);
}

function stripNestedPromptTemplate(goal: string): string | undefined {
  const match = PROMPT_TEMPLATE_HEADING.exec(goal);
  if (!match || match.index <= 0) return undefined;
  const beforeTemplate = goal.slice(0, match.index).trim();
  return beforeTemplate.length >= 5 ? cleanupObjective(beforeTemplate) : undefined;
}

function cleanupObjective(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/\s*\.{3,}\s*$/g, "")
    .replace(/\s*[—-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}
