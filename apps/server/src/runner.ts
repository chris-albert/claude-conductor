import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";
import { extractPortsFromText } from "./ports.js";

export interface RunnerProcess {
  id: string;
  pid: number;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: string;
  ports: number[];
  output: string;
  exitCode: number | null;
}

export interface RunnerState {
  processes: RunnerProcess[];
}

const MAX_AUTO_FIX_RETRIES = 5;
const RUNNING_THRESHOLD_MS = 5000; // If alive this long, consider it "running"

/**
 * Ask Claude to diagnose a failed command and suggest a fix.
 * Uses the Claude Code SDK query() for a one-shot question.
 */
async function askClaudeForFix(
  command: string,
  cwd: string,
  output: string,
  model: string
): Promise<{ fixCommand: string | null; explanation: string }> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const prompt = `A shell command failed. Analyze the error and provide a fix.

Command: ${command}
Working directory: ${cwd}

Output (last 3000 chars):
\`\`\`
${output.slice(-3000)}
\`\`\`

Respond in this EXACT format (two lines only):
FIX: <single shell command to fix the issue>
EXPLAIN: <one sentence explanation>

If the error is unfixable (e.g. syntax error in the command itself), respond:
FIX: none
EXPLAIN: <why it can't be auto-fixed>

Examples:
FIX: pnpm install
EXPLAIN: Dependencies are not installed

FIX: npm run build
EXPLAIN: Build step is required before starting the dev server`;

    let result = "";
    for await (const msg of query({ prompt, options: { model, cwd, maxTurns: 1 } })) {
      const anyMsg = msg as Record<string, unknown>;
      if (anyMsg.type === "assistant") {
        const content = (anyMsg.message as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type === "text") result += block.text;
          }
        }
      }
    }

    const fixMatch = result.match(/FIX:\s*(.+)/i);
    const explainMatch = result.match(/EXPLAIN:\s*(.+)/i);

    const fixCommand = fixMatch?.[1]?.trim();
    const explanation = explainMatch?.[1]?.trim() ?? "Unknown issue";

    if (!fixCommand || fixCommand.toLowerCase() === "none") {
      return { fixCommand: null, explanation };
    }

    return { fixCommand, explanation };
  } catch (err) {
    return {
      fixCommand: null,
      explanation: `Failed to get suggestion: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run a command synchronously and return stdout+stderr.
 */
function runSync(command: string, cwd: string): { ok: boolean; output: string } {
  try {
    const out = execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") || e.message };
  }
}

/**
 * Manages processes spawned directly by the conductor server.
 * Includes AI-powered auto-fix: if a command fails, asks Claude
 * for a fix, applies it, and retries.
 *
 * Emits "change" with { sessionId, state: RunnerState }
 */
export class RunnerManager extends EventEmitter {
  private processes = new Map<string, RunnerProcess>();
  private children = new Map<string, ChildProcess>();
  private sessionProcesses = new Map<string, Set<string>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private model = "claude-sonnet-4-6";

  setModel(model: string) {
    this.model = model;
  }

  /**
   * Spawn a command with AI auto-fix.
   * If the command fails, asks Claude to diagnose, applies the fix, and retries.
   * Continues until the process stays running or max retries exhausted.
   */
  smartSpawn(sessionId: string, command: string, cwd: string): RunnerProcess {
    // Create the process record first so UI shows immediately
    const id = crypto.randomUUID();
    const proc: RunnerProcess = {
      id,
      pid: 0,
      sessionId,
      command,
      cwd,
      startedAt: new Date().toISOString(),
      ports: [],
      output: "",
      exitCode: null,
    };

    this.processes.set(id, proc);
    if (!this.sessionProcesses.has(sessionId)) {
      this.sessionProcesses.set(sessionId, new Set());
    }
    this.sessionProcesses.get(sessionId)!.add(id);
    this.emitChange(sessionId);

    // Start the auto-fix loop in the background
    this.autoFixLoop(id, sessionId, command, cwd, 0);

    return proc;
  }

  /**
   * Basic spawn without auto-fix.
   */
  spawn(sessionId: string, command: string, cwd: string): RunnerProcess {
    return this.rawSpawn(sessionId, command, cwd);
  }

  kill(runnerId: string): boolean {
    const child = this.children.get(runnerId);
    const proc = this.processes.get(runnerId);
    if (!child || !proc) return false;
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* */ }
      }, 5000);
      return true;
    } catch { return false; }
  }

  killByPid(pid: number): boolean {
    for (const [id, proc] of this.processes) {
      if (proc.pid === pid && proc.exitCode === null) {
        return this.kill(id);
      }
    }
    return false;
  }

  getState(sessionId: string): RunnerState {
    const ids = this.sessionProcesses.get(sessionId);
    if (!ids) return { processes: [] };
    const processes: RunnerProcess[] = [];
    for (const id of ids) {
      const proc = this.processes.get(id);
      if (proc) processes.push(proc);
    }
    return { processes };
  }

  getRunnerPids(): Set<number> {
    const pids = new Set<number>();
    for (const proc of this.processes.values()) {
      if (proc.exitCode === null && proc.pid > 0) pids.add(proc.pid);
    }
    return pids;
  }

  cleanupSession(sessionId: string) {
    const ids = this.sessionProcesses.get(sessionId);
    if (!ids) return;
    for (const id of [...ids]) this.kill(id);
    setTimeout(() => {
      for (const id of [...ids]) {
        this.processes.delete(id);
        this.children.delete(id);
      }
      this.sessionProcesses.delete(sessionId);
    }, 1000);
  }

  stopAll() {
    for (const [, child] of this.children) {
      try { child.kill("SIGTERM"); } catch { /* */ }
    }
    setTimeout(() => {
      for (const [, child] of this.children) {
        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* */ }
      }
      this.children.clear();
      this.processes.clear();
      this.sessionProcesses.clear();
      for (const [, timer] of this.debounceTimers) clearTimeout(timer);
      this.debounceTimers.clear();
    }, 2000);
  }

  // --- internal ---

  /**
   * The auto-fix loop. Spawns the command, waits for it to either
   * keep running (success) or exit (failure). On failure, asks Claude
   * for a fix, applies it, and retries.
   */
  private async autoFixLoop(
    id: string,
    sessionId: string,
    command: string,
    cwd: string,
    attempt: number,
  ) {
    const proc = this.processes.get(id);
    if (!proc) return;

    if (attempt > 0) {
      this.appendOutput(id, `\n━━ Retry ${attempt}/${MAX_AUTO_FIX_RETRIES}: ${command} ━━\n`);
    } else {
      this.appendOutput(id, `━━ Running: ${command} ━━\n`);
    }

    // Spawn the actual process
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    proc.pid = child.pid ?? 0;
    proc.exitCode = null;
    this.children.set(id, child);
    this.emitChange(sessionId);

    // Capture output
    child.stdout?.on("data", (chunk: Buffer) => this.appendOutput(id, chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.appendOutput(id, chunk.toString()));

    // Wait for the process to either stay running or exit
    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false;

      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          resolve(code ?? 1);
        }
      });

      child.on("error", (err) => {
        this.appendOutput(id, `[error] ${err.message}\n`);
        if (!settled) {
          settled = true;
          resolve(1);
        }
      });

      // If the process is still running after threshold, consider it a success
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null); // null = still running
        }
      }, RUNNING_THRESHOLD_MS);
    });

    if (exitCode === null) {
      // Process is still running — success!
      this.appendOutput(id, `\n━━ Process running (PID ${proc.pid}) ━━\n`);

      // Set up exit handler for if it dies later
      child.on("exit", (code) => {
        proc.exitCode = code;
        this.children.delete(id);
        this.emitChange(sessionId);
      });

      this.emitChange(sessionId);
      return;
    }

    // Process exited — it failed
    proc.exitCode = exitCode;
    this.children.delete(id);
    this.emitChange(sessionId);

    if (attempt >= MAX_AUTO_FIX_RETRIES) {
      this.appendOutput(id, `\n━━ Failed after ${MAX_AUTO_FIX_RETRIES} attempts. ━━\n`);
      return;
    }

    // Ask Claude for help
    this.appendOutput(id, `\n━━ Exited with code ${exitCode}. Asking Claude for help... ━━\n`);

    const { fixCommand, explanation } = await askClaudeForFix(
      command, cwd, proc.output, this.model
    );

    if (!fixCommand) {
      this.appendOutput(id, `━━ Claude: ${explanation} — cannot auto-fix. ━━\n`);
      return;
    }

    this.appendOutput(id, `━━ Claude: ${explanation} ━━\n`);
    this.appendOutput(id, `━━ Running fix: ${fixCommand} ━━\n\n`);

    // Run the fix command synchronously
    const fixResult = runSync(fixCommand, cwd);
    this.appendOutput(id, fixResult.output);

    if (!fixResult.ok) {
      this.appendOutput(id, `\n━━ Fix command failed. Asking Claude again... ━━\n`);
    }

    // Retry the original command (even if fix failed — Claude might suggest something different next time)
    proc.exitCode = null;
    await this.autoFixLoop(id, sessionId, command, cwd, attempt + 1);
  }

  private rawSpawn(sessionId: string, command: string, cwd: string): RunnerProcess {
    const id = crypto.randomUUID();
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const proc: RunnerProcess = {
      id,
      pid: child.pid ?? 0,
      sessionId,
      command,
      cwd,
      startedAt: new Date().toISOString(),
      ports: [],
      output: "",
      exitCode: null,
    };

    this.processes.set(id, proc);
    this.children.set(id, child);
    if (!this.sessionProcesses.has(sessionId)) {
      this.sessionProcesses.set(sessionId, new Set());
    }
    this.sessionProcesses.get(sessionId)!.add(id);

    child.stdout?.on("data", (chunk: Buffer) => this.appendOutput(id, chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.appendOutput(id, chunk.toString()));
    child.on("exit", (code) => {
      proc.exitCode = code;
      this.children.delete(id);
      this.emitChange(sessionId);
    });
    child.on("error", (err) => this.appendOutput(id, `[error] ${err.message}\n`));

    this.emitChange(sessionId);
    return proc;
  }

  private appendOutput(runnerId: string, text: string) {
    const proc = this.processes.get(runnerId);
    if (!proc) return;

    proc.output += text;
    if (proc.output.length > 50_000) {
      proc.output = proc.output.slice(-40_000);
    }

    const ports = extractPortsFromText(text);
    for (const port of ports) {
      if (!proc.ports.includes(port)) proc.ports.push(port);
    }

    if (!this.debounceTimers.has(runnerId)) {
      this.debounceTimers.set(
        runnerId,
        setTimeout(() => {
          this.debounceTimers.delete(runnerId);
          this.emitChange(proc.sessionId);
        }, 500)
      );
    }
  }

  private emitChange(sessionId: string) {
    this.emit("change", {
      sessionId,
      state: this.getState(sessionId),
    });
  }
}
