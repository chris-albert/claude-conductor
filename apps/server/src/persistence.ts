import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { TrackedCommand } from "./processes.js";
import type { RunnerProcess } from "./runner.js";

const PROCESSES_DIR = ".conductor/processes";
const RUNNER_DIR = ".conductor/runner";

export interface PersistedProcessState {
  commands: TrackedCommand[];
  pidToSession: [number, string][];
  pidToToolUseId: [number, string][];
}

export interface PersistedRunnerState {
  processes: RunnerProcess[];
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadProcessSessionState(
  projectRoot: string,
  sessionId: string
): PersistedProcessState | null {
  const file = join(projectRoot, PROCESSES_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as PersistedProcessState;
  } catch {
    return null;
  }
}

export function saveProcessSessionState(
  projectRoot: string,
  sessionId: string,
  state: PersistedProcessState
) {
  ensureDir(join(projectRoot, PROCESSES_DIR));
  writeFileSync(
    join(projectRoot, PROCESSES_DIR, `${sessionId}.json`),
    JSON.stringify(state)
  );
}

export function deleteProcessSessionState(projectRoot: string, sessionId: string) {
  const file = join(projectRoot, PROCESSES_DIR, `${sessionId}.json`);
  try { if (existsSync(file)) unlinkSync(file); } catch { /* */ }
}

export function loadRunnerSessionState(
  projectRoot: string,
  sessionId: string
): PersistedRunnerState | null {
  const file = join(projectRoot, RUNNER_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as PersistedRunnerState;
  } catch {
    return null;
  }
}

export function saveRunnerSessionState(
  projectRoot: string,
  sessionId: string,
  state: PersistedRunnerState
) {
  ensureDir(join(projectRoot, RUNNER_DIR));
  writeFileSync(
    join(projectRoot, RUNNER_DIR, `${sessionId}.json`),
    JSON.stringify(state)
  );
}

export function deleteRunnerSessionState(projectRoot: string, sessionId: string) {
  const file = join(projectRoot, RUNNER_DIR, `${sessionId}.json`);
  try { if (existsSync(file)) unlinkSync(file); } catch { /* */ }
}

export function listPersistedRunnerSessions(projectRoot: string): string[] {
  const dir = join(projectRoot, RUNNER_DIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
