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
  | "USER_PREFERENCE"
  | "FAILURE_RECOVERY";

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

export interface InterviewQuestionDecision {
  index: number;
  prompt: string;
  options?: DecisionOption[];
  recommendation?: string;
  selectedOptionId?: string;
  selectedOptionLabel?: string;
  customAnswer?: string;
  finalAnswer: string;
  skipped?: boolean;
}

export interface DecisionResult {
  requestId: string;
  optionId: string;
  feedback?: string;
  interviewQuestions?: InterviewQuestionDecision[];
  decidedAt: string;
}
