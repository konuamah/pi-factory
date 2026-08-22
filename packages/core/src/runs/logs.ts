import { readLatestFactoryRunStatus } from "./status.js";
import {
  readFactoryRunLogs,
  type FactoryRunLogsByIdResult as FactoryRunLogsResult,
} from "./logs-by-id.js";

export async function readLatestFactoryRunLogs(
  runsDir: string,
  options?: { limit?: number },
): Promise<FactoryRunLogsResult> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.state?.runId) {
    return { events: [] };
  }

  return readFactoryRunLogs(runsDir, latest.state.runId, options);
}
