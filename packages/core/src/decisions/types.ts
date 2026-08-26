export type DecisionSource =
  | "PLANNER"
  | "BUILDER"
  | "REVIEWER"
  | "VERIFICATION"
  | "CONSTITUTION"
  | "INTERVIEW"
  | "CAPABILITY"
  | "RUNTIME";

export type DecisionReason =
  | "CONFLICT"
  | "AMBIGUOUS_REQUIREMENT"
  | "MISSING_AUTHORITY"
  | "SCOPE_CHOICE"
  | "IRREVERSIBLE_CHOICE"
  | "USER_PREFERENCE";

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface DecisionRequest {
  id: string;
  title: string;
  question: string;
  context?: string;
  options: DecisionOption[];
  evidenceRefs?: string[];
  source: DecisionSource;
  reason: DecisionReason;
}

export interface DecisionResult {
  requestId: string;
  optionId: string;
  feedback?: string;
  decidedAt: string;
}
