// Steward slide helpers — extracted from gateway-setup.ts.

import { renderLines, renderIntro } from "./gateway-render.js";
import type { FactoryPiCommandContext } from "./types.js";
import type { StewardReviewSlide } from "./gateway-concierge.js";

export function stewardSlideSummaryLines(slide: StewardReviewSlide): string[] {
  const body = slide.lines.filter((line) => !/widget truncated/i.test(line));
  const maxBodyLines = 9;
  const visible = body.slice(0, maxBodyLines);
  const hidden = Math.max(0, body.length - visible.length);
  return [
    slide.simpleTitle,
    `(${slide.title} — ${slide.kind})`,
    "",
    ...visible,
    ...(hidden > 0 ? ["", `${hidden} more line(s). Choose Show details to read the full section.`] : []),
  ];
}

export async function showStewardSlideDetails(ctx: FactoryPiCommandContext, slide: StewardReviewSlide): Promise<void> {
  const detailLines = stewardSlideDetailLines(slide);
  if (ctx.ui.custom) {
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let scrollOffset = 0;
      return {
        render(width: number): string[] {
          const safeWidth = Math.max(20, width);
          const header = [
            `${slide.title} details`,
            `id: ${slide.id} · kind: ${slide.kind}`,
            "",
          ];
          const footer = [
            "",
            "↑↓ scroll · enter/escape close",
          ];
          const wrapped = detailLines.flatMap((line) => wrapWidgetLine(line, safeWidth));
          const availableRows = Math.max(6, 22 - header.length - footer.length - 1);
          const maxOffset = Math.max(0, wrapped.length - availableRows);
          scrollOffset = Math.min(scrollOffset, maxOffset);
          const visible = wrapped.slice(scrollOffset, scrollOffset + availableRows);
          const position = wrapped.length > availableRows
            ? [`Showing ${scrollOffset + 1}-${Math.min(wrapped.length, scrollOffset + availableRows)} of ${wrapped.length}`]
            : [];
          return [...header, ...position, ...visible, ...footer].map((line) => truncateWidgetLine(line, width));
        },
        handleInput(data: string) {
          if (data === "\r" || data === "\n" || data === "\u001b") {
            done();
            return;
          }
          if (data === "\u001b[A") {
            scrollOffset = Math.max(0, scrollOffset - 1);
            tui.requestRender();
          } else if (data === "\u001b[B") {
            scrollOffset += 1;
            tui.requestRender();
          }
        },
        invalidate() {},
      };
    });
    return;
  }

  renderLines(ctx, [
    `${slide.title} details`,
    `id: ${slide.id}`,
    "",
    ...detailLines.slice(0, 24),
    ...(detailLines.length > 24 ? ["", `${detailLines.length - 24} more line(s) hidden by this shell. Use an interactive Pi TUI for scrollable details.`] : []),
  ]);
}

export function stewardSlideDetailLines(slide: StewardReviewSlide): string[] {
  const lines = [
    "Recommendation view",
    ...slide.lines.filter((line) => !/widget truncated/i.test(line)),
  ];
  if (slide.details?.length) {
    lines.push("", "Additional detail", ...slide.details);
  }
  if (slide.recommended !== undefined) {
    lines.push("", "Raw recommendation", ...JSON.stringify(slide.recommended, null, 2).split(/\r?\n/));
  }
  return lines;
}

export function stewardSlideOptions(slideId: string, slideIndex: number): string[] {
  return [
    slideId === "understanding" ? "Looks right" : "Next / Use this",
    ...(slideIndex > 0 ? ["Back"] : []),
    ...(stewardSlideCanCustomize(slideId) ? [slideId === "understanding" ? "Correct something" : "Customize"] : []),
    "Show details",
    "Cancel",
  ];
}

export function stewardSlideDetailOptions(slideId: string, slideIndex: number): string[] {
  return [
    slideId === "understanding" ? "Looks right" : "Next / Use this",
    ...(slideIndex > 0 ? ["Back"] : []),
    ...(stewardSlideCanCustomize(slideId) ? [slideId === "understanding" ? "Correct something" : "Customize"] : []),
    "Cancel",
  ];
}

export function stewardSlideCanCustomize(slideId: string): boolean {
  return slideId !== "finalReview";
}

export function isCustomizeChoice(choice: string): boolean {
  return choice === "Customize" || choice === "Correct something";
}

export function truncateWidgetLine(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

export function wrapWidgetLine(value: string, width: number): string[] {
  if (width <= 0) return [""];
  if (value.length === 0) return [""];
  const out: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    out.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  out.push(remaining);
  return out;
}

export function renderSetupSummary(
  ctx: import("@factory/schemas").FactorySetupContext,
  rec: import("@factory/schemas").FactorySetupRecommendation,
): string[] {
  const langs = ctx.repository.languages.join(", ") || "none";
  const pms = ctx.repository.packageManagers.join(", ") || "none";
  const frameworks = ctx.repository.frameworks.join(", ") || "none";
  const discoveredCount = Object.values(ctx.discoveredCommands).filter(Boolean).length;
  const wfVal = rec.workflow?.value as { kind?: string; preset?: string; workflow?: { stages: Array<{ name: string }> } } | undefined;
  const presetLabel = wfVal?.kind === "custom" ? `Custom (${wfVal.workflow?.stages.map((s) => s.name).join(" → ") ?? "custom"})` : wfVal?.preset ? wfVal.preset.charAt(0).toUpperCase() + wfVal.preset.slice(1) : "Balanced";
  const cmds = Object.values(rec.commands ?? {}).map((c) => c!.value).join(", ") || "none";
  return [
    "Factory checked this project.",
    "",
    "I found:",
    `  ${langs}`,
    `  ${pms}`,
    ...(frameworks !== "none" ? [`  ${frameworks}`] : []),
    `  Git`,
    `  ${discoveredCount} build/verification command(s)`,
    "",
    "I recommend:",
    `  Workflow    ${presetLabel}`,
    ...(rec.models ? [`  Models      ${Object.entries(rec.models).map(([r, v]) => `${r}:${v!.value.model}`).join(", ")}`] : []),
    `  Verification  ${cmds}`,
    `  Parallel workers  ${rec.runtime?.maxParallelAgents?.value ?? 2}`,
    `  Repair  Up to ${rec.repair?.maxAttempts?.value ?? 3} attempts`,
    `  Final merge  ${rec.approval?.finalMerge?.value === "required" ? "Ask for approval" : "Auto-merge"}`,
    "",
    `I can also ${rec.constitution === "GENERATE" ? "generate" : rec.constitution === "REFRESH" ? "refresh" : "keep"} the repository constitution.`,
    "",
    "Why this setup?",
    ...(rec.explanation.slice(0, 2).map((e) => `  ${e}`)),
    "",
    rec.summary,
  ];
}

export function renderSetupDetails(
  ctx: import("@factory/schemas").FactorySetupContext,
  rec: import("@factory/schemas").FactorySetupRecommendation,
): string[] {
  const lines: string[] = ["Details", ""];
  const src = ctx.existing;
  const provenance = (field: string, existingValue: unknown): string => {
    if (existingValue !== undefined && existingValue !== null && existingValue !== "") return `Source: Project configuration`;
    const g = src.global as Record<string, unknown> | undefined;
    if (g && (g as Record<string, unknown>)[field] !== undefined) return `Source: Global configuration`;
    return `Source: Built-in default`;
  };
  if (rec.models) {
    for (const [role, entry] of Object.entries(rec.models)) {
      lines.push(`  ${role}: ${entry!.value.model}${entry!.value.provider ? ` (${entry!.value.provider})` : ""} — ${entry!.reason}`);
      lines.push(`    ${provenance(role, (src.project?.models as Record<string, unknown> | undefined)?.[role])} / ${entry!.reason}`);
    }
  }
  if (rec.commands) {
    for (const [field, r] of Object.entries(rec.commands)) {
      if (!r) continue;
      const flag = r.source === "DISCOVERED" ? "✓" : r.source === "AI_SUGGESTED" ? "?" : "·";
      lines.push(`  ${field}: ${flag} ${r.value} [${r.source}] — ${r.reason}` + (r.requiresConfirmation ? " (needs confirmation)" : ""));
    }
  }
  if (rec.capabilities?.allow?.length) lines.push(`  capabilities allow: ${rec.capabilities.allow.join(", ")}`);
  if (rec.capabilities?.deny?.length) lines.push(`  capabilities deny: ${rec.capabilities.deny.join(", ")}`);
  if (rec.dependencies) {
    if (rec.dependencies.enabled) lines.push(`  dependency hydration: ${rec.dependencies.enabled.value ? "enabled" : "disabled"} — ${rec.dependencies.enabled.reason}`);
    if (rec.dependencies.hydrate) lines.push(`  dependency hydrate mode: ${rec.dependencies.hydrate.value} — ${rec.dependencies.hydrate.reason}`);
    if (rec.dependencies.cacheRoot) lines.push(`  dependency cache root: ${rec.dependencies.cacheRoot.value} — ${rec.dependencies.cacheRoot.reason}`);
  }
  if (rec.taskTypes?.length) lines.push(`  task types: ${rec.taskTypes.map((t) => t.id).join(", ")}`);
  lines.push(`  constitution: ${rec.constitution}`);
  lines.push("");
  lines.push(`Available models: ${ctx.availableModels.map((m) => (m.provider ? `${m.provider}/` : "") + m.model).join(", ")}`);
  lines.push(`Available capabilities: ${ctx.availableCapabilities.join(", ")}`);
  return lines;
}

