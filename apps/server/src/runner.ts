import { spawn, execFile, execSync, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { createServer } from "net";
import {
  listPersistedRunnerSessions,
  loadRunnerSessionState,
  saveRunnerSessionState,
} from "./persistence.js";
import { isProtectedPid } from "./protectedPids.js";

export interface PortSlot {
  /** Slot name (uppercase env var prefix, e.g. "WEB" → WEB_PORT). "PORT" for the unnamed default. */
  name: string;
  port: number;
  /** True if the port was specified by config (not auto-allocated). */
  fixed?: boolean;
}

export interface SlotSpec {
  name: string;
  /** If set, use this exact port instead of allocating a free one. */
  port?: number;
}

export interface RunnerProcess {
  id: string;
  pid: number;
  sessionId: string;
  command: string;
  description?: string;
  cwd: string;
  startedAt: string;
  /** Ports detected via lsof scan (includes ephemeral/IPC noise). */
  ports: number[];
  /** Ports conductor allocated for this process and injected as env vars. */
  slots: PortSlot[];
  output: string;
  exitCode: number | null;
}

export interface RunnerState {
  processes: RunnerProcess[];
}

export interface SpawnOptions {
  description?: string;
  /** Named port slots. Empty → conductor injects PORT only. */
  slots?: SlotSpec[];
}

function normalizeSlotName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Ask the OS for a free TCP port. Releases the listener immediately. */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function allocatePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) ports.push(await allocatePort());
  return ports;
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
  private portScanTimer: ReturnType<typeof setInterval> | null = null;
  private model = "claude-opus-4-6";
  private projectRoot?: string;
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot;
    if (projectRoot) this.rehydrateFromDisk(projectRoot);
  }

  setModel(model: string) {
    this.model = model;
  }

  /**
   * Spawn a command with AI auto-fix.
   * If the command fails, asks Claude to diagnose, applies the fix, and retries.
   * Continues until the process stays running or max retries exhausted.
   */
  smartSpawn(
    sessionId: string,
    command: string,
    cwd: string,
    opts: SpawnOptions = {}
  ): RunnerProcess {
    // Create the process record first so UI shows immediately
    const id = crypto.randomUUID();
    const proc: RunnerProcess = {
      id,
      pid: 0,
      sessionId,
      command,
      description: opts.description,
      cwd,
      startedAt: new Date().toISOString(),
      ports: [],
      slots: [],
      output: "",
      exitCode: null,
    };

    this.processes.set(id, proc);
    if (!this.sessionProcesses.has(sessionId)) {
      this.sessionProcesses.set(sessionId, new Set());
    }
    this.sessionProcesses.get(sessionId)!.add(id);
    this.emitChange(sessionId);

    // Allocate ports, then start the auto-fix loop
    this.allocateAndStart(id, sessionId, command, cwd, opts.slots ?? []).catch((err) => {
      console.error(`[conductor] runner ${id} crashed:`, err);
      this.appendOutput(id, `\n━━ Internal error: ${err?.message ?? err} ━━\n`);
      const p = this.processes.get(id);
      if (p && p.exitCode === null) {
        p.exitCode = 1;
        this.emitChange(p.sessionId);
      }
    });
    this.startPortScanning();

    return proc;
  }

  private async allocateAndStart(
    id: string,
    sessionId: string,
    command: string,
    cwd: string,
    slotSpecs: SlotSpec[],
  ) {
    const proc = this.processes.get(id);
    if (!proc) return;

    const envAdditions: Record<string, string> = {};
    try {
      if (slotSpecs.length === 0) {
        // Default: inject a single PORT for the common case
        const port = await allocatePort();
        envAdditions.PORT = String(port);
        proc.slots = [{ name: "PORT", port }];
      } else {
        const slots: PortSlot[] = [];
        for (const spec of slotSpecs) {
          const name = normalizeSlotName(spec.name);
          const port = typeof spec.port === "number" ? spec.port : await allocatePort();
          const envKey = name === "PORT" ? "PORT" : `${name}_PORT`;
          envAdditions[envKey] = String(port);
          slots.push({ name, port, fixed: typeof spec.port === "number" });
        }
        proc.slots = slots;
      }
    } catch {
      // Allocation failed — proceed without env injection
    }
    this.emitChange(sessionId);

    this.autoFixLoop(id, sessionId, command, cwd, 0, envAdditions);
  }

  /**
   * Basic spawn without auto-fix.
   */
  spawn(sessionId: string, command: string, cwd: string): RunnerProcess {
    return this.rawSpawn(sessionId, command, cwd);
  }

  async kill(runnerId: string): Promise<boolean> {
    const child = this.children.get(runnerId);
    const proc = this.processes.get(runnerId);
    if (!child || !proc) return false;

    // Kill the entire process tree (shell → npm → node, etc.).
    // Guard: skip pids in the conductor host's own ancestor chain so a runner
    // whose tree overlaps with conductor's parent shell can't SIGTERM us.
    const descendants = proc.pid > 0 ? await this.getDescendantPids(proc.pid) : [];
    const safeDescendants = descendants.filter((pid) => !isProtectedPid(pid));

    // Kill descendants bottom-up first, then the root
    for (const pid of safeDescendants.reverse()) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
    try { child.kill("SIGTERM"); } catch { /* already dead */ }

    // Mark as killed immediately so UI updates
    proc.exitCode = proc.exitCode ?? 143; // 128 + 15 (SIGTERM)
    this.children.delete(runnerId);
    this.emitChange(proc.sessionId);

    // Escalate to SIGKILL after 3 seconds for any survivors
    setTimeout(() => {
      (async () => {
        const remaining = proc.pid > 0 ? await this.getDescendantPids(proc.pid) : [];
        for (const pid of remaining) {
          if (isProtectedPid(pid)) continue;
          try { process.kill(pid, "SIGKILL"); } catch { /* */ }
        }
        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* */ }
      })().catch((err) => {
        console.error("[conductor] SIGKILL escalation error:", err);
      });
    }, 3000);

    return true;
  }

  async killByPid(pid: number): Promise<boolean> {
    for (const [id, proc] of this.processes) {
      if (proc.pid === pid && proc.exitCode === null) {
        return this.kill(id);
      }
    }
    return false;
  }

  /** All runner processes across all sessions, newest first. */
  listAll(): RunnerProcess[] {
    return Array.from(this.processes.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  getState(sessionId: string): RunnerState {
    const ids = this.sessionProcesses.get(sessionId);
    if (!ids) return { processes: [] };
    const processes: RunnerProcess[] = [];
    for (const id of ids) {
      const proc = this.processes.get(id);
      if (proc) processes.push(proc);
    }
    processes.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    return { processes };
  }

  getRunnerPids(): Set<number> {
    const pids = new Set<number>();
    for (const proc of this.processes.values()) {
      if (proc.exitCode === null && proc.pid > 0) pids.add(proc.pid);
    }
    return pids;
  }

  async cleanupSession(sessionId: string) {
    const ids = this.sessionProcesses.get(sessionId);
    if (!ids) return;
    await Promise.all([...ids].map((id) => this.kill(id)));
    setTimeout(() => {
      for (const id of [...ids]) {
        this.processes.delete(id);
        this.children.delete(id);
      }
      this.sessionProcesses.delete(sessionId);
    }, 1000);
  }

  stopAll() {
    this.stopPortScanning();
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
    envAdditions: Record<string, string> = {},
  ) {
    const proc = this.processes.get(id);
    if (!proc) return;

    if (attempt > 0) {
      this.appendOutput(id, `\n━━ Retry ${attempt}/${MAX_AUTO_FIX_RETRIES}: ${command} ━━\n`);
    } else {
      this.appendOutput(id, `━━ Running: ${command} ━━\n`);
    }

    // Spawn the actual process with allocated port env vars merged in
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: { ...process.env, ...envAdditions },
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
      child.on("exit", (code, signal) => {
        proc.exitCode = code ?? (signal ? 128 : 1);
        this.children.delete(id);
        this.emitChange(sessionId);
      });

      this.emitChange(sessionId);
      return;
    }

    // Process exited
    proc.exitCode = exitCode;
    this.children.delete(id);
    this.emitChange(sessionId);

    if (exitCode === 0) {
      this.appendOutput(id, `\n━━ Completed successfully. ━━\n`);
      return;
    }

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
    await this.autoFixLoop(id, sessionId, command, cwd, attempt + 1, envAdditions);
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
      slots: [],
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
    this.startPortScanning();
    return proc;
  }

  private appendOutput(runnerId: string, text: string) {
    const proc = this.processes.get(runnerId);
    if (!proc) return;

    proc.output += text;
    if (proc.output.length > 50_000) {
      proc.output = proc.output.slice(-40_000);
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

  /**
   * Get all descendant PIDs of a process (children, grandchildren, etc.).
   * Walks the full process tree since the listening process may be several
   * levels deep (e.g. shell → npm → node).
   */
  private getDescendantPids(rootPid: number): Promise<number[]> {
    return new Promise((resolve) => {
      // Get full PID/PPID table and walk it to find all descendants
      execFile("ps", ["-eo", "pid=,ppid="], { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const children = new Map<number, number[]>();
        for (const line of stdout.trim().split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)$/);
          if (!m) continue;
          const pid = parseInt(m[1], 10);
          const ppid = parseInt(m[2], 10);
          if (!children.has(ppid)) children.set(ppid, []);
          children.get(ppid)!.push(pid);
        }
        // BFS to collect all descendants
        const result: number[] = [];
        const queue = children.get(rootPid) ?? [];
        while (queue.length > 0) {
          const pid = queue.shift()!;
          result.push(pid);
          const grandchildren = children.get(pid);
          if (grandchildren) queue.push(...grandchildren);
        }
        resolve(result);
      });
    });
  }

  /**
   * Scan actual listening ports for all running runner processes using lsof.
   * Includes child processes since shell: true means the tracked PID is the
   * shell, not the actual server.
   */
  private async scanPorts() {
    const runningPids: number[] = [];
    // Map child PID back to the runner PID it belongs to
    const childToRunner = new Map<number, number>();

    for (const proc of this.processes.values()) {
      if (proc.exitCode === null && proc.pid > 0) runningPids.push(proc.pid);
    }
    if (runningPids.length === 0) return;

    // Collect child PIDs for all runners
    const allPids = [...runningPids];
    await Promise.all(
      runningPids.map(async (pid) => {
        const children = await this.getDescendantPids(pid);
        for (const child of children) {
          childToRunner.set(child, pid);
          allPids.push(child);
        }
      })
    );

    const pidPorts = await new Promise<Map<number, number[]>>((resolve) => {
      execFile(
        "lsof",
        ["-a", "-p", allPids.join(","), "-i", "-P", "-n", "-sTCP:LISTEN"],
        { timeout: 5000 },
        (err, stdout) => {
          // Accumulate ports per runner PID (not per child PID)
          const map = new Map<number, number[]>();
          if (err || !stdout) {
            resolve(map);
            return;
          }
          const lines = stdout.trim().split("\n").slice(1);
          for (const line of lines) {
            const cols = line.split(/\s+/);
            if (cols.length < 9) continue;
            const lsofPid = parseInt(cols[1], 10);
            const portMatch = cols[8].match(/:(\d+)$/);
            if (!portMatch) continue;
            const port = parseInt(portMatch[1], 10);
            if (port < 1024) continue;
            // Map back to the runner PID
            const runnerPid = childToRunner.get(lsofPid) ?? lsofPid;
            if (!map.has(runnerPid)) map.set(runnerPid, []);
            if (!map.get(runnerPid)!.includes(port)) map.get(runnerPid)!.push(port);
          }
          resolve(map);
        }
      );
    });

    const changedSessions = new Set<string>();
    for (const proc of this.processes.values()) {
      if (proc.exitCode !== null || proc.pid <= 0) continue;
      const realPorts = (pidPorts.get(proc.pid) ?? []).sort((a, b) => a - b);
      const oldPorts = JSON.stringify(proc.ports);
      if (JSON.stringify(realPorts) !== oldPorts) {
        proc.ports = realPorts;
        changedSessions.add(proc.sessionId);
      }
    }
    for (const sessionId of changedSessions) {
      this.emitChange(sessionId);
    }
  }

  private startPortScanning() {
    if (this.portScanTimer) return;
    this.portScanTimer = setInterval(() => {
      this.scanPorts().catch((err) => {
        console.error("[conductor] scanPorts error:", err);
      });
    }, 3000);
  }

  private stopPortScanning() {
    if (this.portScanTimer) {
      clearInterval(this.portScanTimer);
      this.portScanTimer = null;
    }
  }

  private emitChange(sessionId: string) {
    this.schedulePersist(sessionId);
    this.emit("change", {
      sessionId,
      state: this.getState(sessionId),
    });
  }

  private rehydrateFromDisk(projectRoot: string) {
    for (const sessionId of listPersistedRunnerSessions(projectRoot)) {
      const persisted = loadRunnerSessionState(projectRoot, sessionId);
      if (!persisted) continue;
      for (const proc of persisted.processes) {
        // Default new fields for older persisted data
        proc.slots = proc.slots ?? [];
        if (proc.exitCode === null) {
          proc.exitCode = 130;
          proc.output =
            (proc.output ?? "") +
            "\n━━ Process terminated due to server restart ━━\n";
        }
        this.processes.set(proc.id, proc);
        if (!this.sessionProcesses.has(proc.sessionId)) {
          this.sessionProcesses.set(proc.sessionId, new Set());
        }
        this.sessionProcesses.get(proc.sessionId)!.add(proc.id);
      }
    }
  }

  private schedulePersist(sessionId: string) {
    if (!this.projectRoot) return;
    if (this.persistTimers.has(sessionId)) return;
    this.persistTimers.set(
      sessionId,
      setTimeout(() => {
        this.persistTimers.delete(sessionId);
        this.persistNow(sessionId);
      }, 500)
    );
  }

  private persistNow(sessionId: string) {
    if (!this.projectRoot) return;
    try {
      saveRunnerSessionState(this.projectRoot, sessionId, this.getState(sessionId));
    } catch { /* best effort */ }
  }
}
