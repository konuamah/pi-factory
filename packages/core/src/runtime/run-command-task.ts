// Command-task execution — extracted from implementation-task.ts.

import { appendFactoryRunEvent } from "../runs/store.js";
import { updatePrototypeTaskArtifact } from "./tasks.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlannerTask } from "./planner.js";
import type { TaskWorkspaceSelection } from "./controller.js";

const execFileAsync = promisify(execFile);

export async function runCommandTasks(
  input: { task: PlannerTask; eventsPath: string; runDir: string },
  workspace: TaskWorkspaceSelection,
): Promise<{ ok: true; task: PlannerTask; workspace: TaskWorkspaceSelection } | { ok: false; task: PlannerTask; workspace: TaskWorkspaceSelection }> {
  if (input.task.type === "command" && input.task.commands?.length) {
    for (const command of input.task.commands) {
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.command_started",
        data: {
          taskId: input.task.id,
          command,
          workspacePath: workspace.path,
        },
      });
      try {
        const { stdout, stderr } = await execFileAsync(command, { cwd: workspace.path, shell: true, windowsHide: true });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.command_completed",
          data: {
            taskId: input.task.id,
            command,
            status: "passed",
            stdout,
            stderr,
          },
        });
      } catch (error) {
        const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.command_failed",
          data: {
            taskId: input.task.id,
            command,
            status: "failed",
            exitCode: execError.code,
            stdout: execError.stdout,
            stderr: execError.stderr,
          },
        });
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            command,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
    }
  }
  return { ok: true, task: input.task, workspace };
}
