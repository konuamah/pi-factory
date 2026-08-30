// Event-derived timing for one run. Human wait (decision.required -> the
// matching decision.resolved) is separated from agent time, because wall-clock
// alone penalizes the model for a person thinking.

import type { RunEvent } from "../runs/artifacts-read.js";
import type { RunTiming } from "./types.js";

const HANDOFF_ORDER = [
  ["run.created", "phase.discovery"],
  ["phase.discovery", "phase.planning"],
  ["phase.planning", "phase.plan-approval"],
  ["phase.plan-approval", "phase.implementation"],
  ["phase.implementation", "phase.verification"],
  ["phase.verification", "phase.review"],
  ["phase.review", "phase.approval-ready"],
  ["phase.approval-ready", "phase.landing-planning"],
  ["phase.landing-planning", "run.completed"],
] as const;

export function computeRunTiming(events: RunEvent[]): RunTiming {
  const stamps = events
    .filter((event) => typeof event.timestamp === "string")
    .map((event) => ({ type: event.type, at: Date.parse(event.timestamp), data: event.data }))
    .filter((event) => Number.isFinite(event.at));

  const first = stamps[0]?.at ?? 0;
  const last = stamps.at(-1)?.at ?? first;

  // Phase duration = until the next phase marker, whatever it was.
  const phases: Record<string, number> = {};
  const phaseEvents = stamps.filter((event) => event.type.startsWith("phase."));
  phaseEvents.forEach((event, index) => {
    const next = phaseEvents[index + 1]?.at ?? last;
    phases[event.type.slice("phase.".length)] = (phases[event.type.slice("phase.".length)] ?? 0) + Math.max(0, next - event.at);
  });

  // Human wait: each decision.required until its decision.resolved.
  let humanWaitMs = 0;
  const openDecisions: number[] = [];
  for (const event of stamps) {
    if (event.type === "decision.required") {
      openDecisions.push(event.at);
    } else if (event.type === "decision.resolved" && openDecisions.length > 0) {
      humanWaitMs += Math.max(0, event.at - (openDecisions.shift() as number));
    }
  }

  const handoffs: Record<string, number | null> = {};
  for (const [from, to] of HANDOFF_ORDER) {
    const start = stamps.find((event) => event.type === from)?.at;
    const end = stamps.find((event) => event.type === to)?.at;
    handoffs[`${from}->${to}`] = start !== undefined && end !== undefined && end >= start ? end - start : null;
  }

  const totalMs = Math.max(0, last - first);
  return { totalMs, humanWaitMs, agentMs: Math.max(0, totalMs - humanWaitMs), phases, handoffs };
}
