import { execFile, spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync, readlinkSync } from "fs";
import {
  isPidAlive,
  loadProcessSessionState,
  saveProcessSessionState,
} from "./persistence.js";

export interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
  ports: number[];
  /** Output from the Bash command that spawned this process */
  output?: string;
}

export interface TrackedCommand {
  command: string;
  timestamp: string;
  toolUseId: string;
  output?: string;
}

export interface SessionProcessState {
  /** Bash commands Claude executed in this session */
  commands: TrackedCommand[];
  /** Active processes listening on ports, scoped to this session */
  processes: ProcessInfo[];
}

const IGNORED_PORTS = new Set([22, 53, 80, 443]);

/**
 * Tracks processes and commands spawned by Claude sessions.
 *
 * Process scoping: only processes spawned by Claude are shown, tracked via:
 * 1. PID snapshotting — baseline PIDs are recorded; anything new after a
 *    Bash command is attributed to that session
 * 2. Port association — ports detected from tool output link to sessions
 *
 * Emits "change" with { sessionId, state: SessionProcessState }
 */
export class ProcessManager extends EventEmitter {
  private sessions = new Map<string, SessionProcessState>();
  /** PID → sessionId (from snapshot-based detection) */
  private pidToSession = new Map<number, string>();
  /** PID → toolUseId (links a process to the command that spawned it) */
  private pidToToolUseId = new Map<number, string>();
  /** PIDs seen in scans — used as baseline to detect new processes */
  private baselinePids = new Set<number>();
  /** Live output captured per PID */
  private pidOutput = new Map<number, string>();
  /** Live output captured per toolUseId (from Claude Code output files) */
  private toolOutput = new Map<string, string>();
  /** Active output tailers per key (PID or toolUseId) */
  private outputTailers = new Map<string, ChildProcess>();
  /** Debounce timers for output change events */
  private outputDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** toolUseId → output file path (from Claude Code background tasks) */
  private toolOutputFiles = new Map<string, string>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanIntervalMs: number;
  /** PIDs to exclude from scans (managed by RunnerManager) */
  public excludePids = new Set<number>();
  /** Project root for persistence (optional) */
  private projectRoot?: string;
  /** Debounce timers for disk writes per session */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(scanIntervalMs = 5000, projectRoot?: string) {
    super();
    this.scanIntervalMs = scanIntervalMs;
    this.projectRoot = projectRoot;
  }

  trackSession(sessionId: string) {
    if (!this.sessions.has(sessionId)) {
      const restored = this.loadFromDisk(sessionId);
      this.sessions.set(sessionId, restored ?? { commands: [], processes: [] });
    }
    this.startScanning();
  }

  untrackSession(sessionId: string) {
    for (const [pid, sid] of this.pidToSession) {
      if (sid === sessionId) {
        this.stopOutputCapture(pid);
        this.pidOutput.delete(pid);
        this.pidToSession.delete(pid);
        this.pidToToolUseId.delete(pid);
      }
    }
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) this.stopScanning();
  }

  /** Record a Bash command that Claude executed */
  addCommand(sessionId: string, command: string, toolUseId: string) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.commands.push({
      command: command.trim(),
      timestamp: new Date().toISOString(),
      toolUseId,
    });
    if (state.commands.length > 50) state.commands.shift();
    this.emitChange(sessionId);
  }

  /** Attach output from a tool_result to the matching command */
  addCommandOutput(sessionId: string, toolUseId: string, output: string) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const cmd = state.commands.find((c) => c.toolUseId === toolUseId);
    if (!cmd) return;
    cmd.output =
      output.length > 20_000
        ? output.slice(0, 20_000) + "\n... (truncated)"
        : output;

    // Detect Claude Code background task output files
    // Pattern: "Output is being written to: /path/to/file"
    const outputFileMatch = output.match(
      /(?:output\s+(?:is\s+)?(?:being\s+)?written\s+to|writing\s+(?:output\s+)?to)[:\s]+(\S+\.output)/i
    );
    if (outputFileMatch) {
      const filePath = outputFileMatch[1];
      this.toolOutputFiles.set(toolUseId, filePath);
      this.startFileTail(toolUseId, filePath, sessionId);
    }

    this.emitChange(sessionId);
  }

  /**
   * Called after a Bash command completes (tool_result received).
   * Scans for new listening processes that appeared during the command
   * and associates them with the session.
   */
  async postCommandScan(sessionId: string, toolUseId: string) {
    // Small delay to let spawned processes start listening
    await new Promise((r) => setTimeout(r, 1500));
    const listening = await this.scanListening();
    let changed = false;
    for (const proc of listening) {
      if (!this.baselinePids.has(proc.pid)) {
        this.pidToSession.set(proc.pid, sessionId);
        this.pidToToolUseId.set(proc.pid, toolUseId);
        this.baselinePids.add(proc.pid);
        this.startOutputCapture(proc.pid);
        changed = true;
      }
    }
    if (changed) {
      await this.scan();
    }
  }

  getState(sessionId: string): SessionProcessState {
    if (!this.sessions.has(sessionId)) {
      const restored = this.loadFromDisk(sessionId);
      if (restored) this.sessions.set(sessionId, restored);
    }
    return this.sessions.get(sessionId) ?? { commands: [], processes: [] };
  }

  async killProcess(pid: number): Promise<boolean> {
    // Send SIGTERM first
    const termOk = await new Promise<boolean>((resolve) => {
      execFile("kill", ["-TERM", String(pid)], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });

    if (termOk) {
      // Wait briefly, then check if process is still alive and escalate to SIGKILL
      await new Promise((r) => setTimeout(r, 3000));
      await new Promise<void>((resolve) => {
        execFile("kill", ["-0", String(pid)], (err) => {
          if (!err) {
            // Still alive — force kill
            execFile("kill", ["-KILL", String(pid)], () => resolve());
          } else {
            resolve();
          }
        });
      });
    }

    // Clean up state regardless
    this.stopOutputCapture(pid);
    this.pidOutput.delete(pid);
    this.pidToSession.delete(pid);
    this.pidToToolUseId.delete(pid);
    this.baselinePids.delete(pid);
    setTimeout(() => this.scan(), 500);

    return termOk;
  }

  async scan() {
    const listening = await this.scanListening();

    // Update baseline with all currently-listening PIDs
    const currentPids = new Set(listening.map((p) => p.pid));
    // Add new PIDs to baseline (but don't remove killed ones — they drop naturally)
    for (const pid of currentPids) {
      this.baselinePids.add(pid);
    }
    // Clean up stale PID associations and tailers for processes that stopped
    for (const pid of this.pidToSession.keys()) {
      if (!currentPids.has(pid)) {
        this.pidToSession.delete(pid);
        this.pidToToolUseId.delete(pid);
        this.stopOutputCapture(pid);
        this.pidOutput.delete(pid);
      }
    }

    // Group processes by session — ONLY include Claude-spawned processes
    const sessionProcs = new Map<string, ProcessInfo[]>();

    for (const proc of listening) {
      const sessionId = this.pidToSession.get(proc.pid) ?? null;
      if (!sessionId) continue; // Not a Claude-spawned process
      if (this.excludePids.has(proc.pid)) continue; // Managed by RunnerManager

      // Resolve output: Claude Code file tail > PID tail > tool_result
      const toolUseId = this.pidToToolUseId.get(proc.pid);
      let output = toolUseId ? this.toolOutput.get(toolUseId) : undefined;
      if (!output) output = this.pidOutput.get(proc.pid);
      if (!output && toolUseId && sessionId) {
        const state = this.sessions.get(sessionId);
        const cmd = state?.commands.find((c) => c.toolUseId === toolUseId);
        output = cmd?.output;
      }

      const list = sessionProcs.get(sessionId) ?? [];
      list.push({ ...proc, output });
      sessionProcs.set(sessionId, list);
    }

    for (const [sessionId, state] of this.sessions) {
      const newProcs = sessionProcs.get(sessionId) ?? [];
      const oldJson = JSON.stringify(state.processes);
      const newJson = JSON.stringify(newProcs);
      if (oldJson !== newJson) {
        state.processes = newProcs;
        this.emitChange(sessionId);
      }
    }
  }

  /** Start tailing a Claude Code output file for a tool invocation */
  private startFileTail(key: string, filePath: string, sessionId: string) {
    if (this.outputTailers.has(key)) return;
    if (!existsSync(filePath)) {
      // File may not exist yet — retry shortly
      setTimeout(() => {
        if (existsSync(filePath) && !this.outputTailers.has(key)) {
          this.startFileTail(key, filePath, sessionId);
        }
      }, 2000);
      return;
    }

    const tailer = spawn("tail", ["-f", "-n", "+1", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    this.outputTailers.set(key, tailer);
    this.toolOutput.set(key, "");

    tailer.stdout?.on("data", (chunk: Buffer) => {
      const current = this.toolOutput.get(key) ?? "";
      let updated = current + chunk.toString();
      if (updated.length > 50_000) {
        updated = updated.slice(-40_000);
      }
      this.toolOutput.set(key, updated);

      // Debounce updates
      if (!this.outputDebounce.has(key)) {
        this.outputDebounce.set(
          key,
          setTimeout(() => {
            this.outputDebounce.delete(key);
            this.emitChange(sessionId);
          }, 500)
        );
      }
    });

    tailer.on("exit", () => {
      this.outputTailers.delete(key);
    });
  }

  /** Start capturing output for a tracked process by PID */
  private startOutputCapture(pid: number) {
    const key = `pid:${pid}`;
    if (this.outputTailers.has(key)) return;

    // Check if we already have a file tail for this PID's toolUseId
    const toolUseId = this.pidToToolUseId.get(pid);
    if (toolUseId && this.outputTailers.has(toolUseId)) return;

    // Try /proc/PID/fd/1 → regular file (Linux)
    const procFd = `/proc/${pid}/fd/1`;
    let source: string | null = null;
    if (existsSync(procFd)) {
      try {
        const target = readlinkSync(procFd);
        if (
          target.startsWith("/") &&
          !target.startsWith("pipe:") &&
          !target.startsWith("socket:")
        ) {
          source = target;
        }
      } catch { /* ignore */ }
    }

    if (!source) return; // Can't capture on macOS without a file

    const sessionId = this.pidToSession.get(pid);
    if (!sessionId) return;

    const tailer = spawn("tail", ["-f", "-n", "200", source], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    this.outputTailers.set(key, tailer);
    this.pidOutput.set(pid, "");

    tailer.stdout?.on("data", (chunk: Buffer) => {
      const current = this.pidOutput.get(pid) ?? "";
      let updated = current + chunk.toString();
      if (updated.length > 50_000) {
        updated = updated.slice(-40_000);
      }
      this.pidOutput.set(pid, updated);

      if (!this.outputDebounce.has(key)) {
        this.outputDebounce.set(
          key,
          setTimeout(() => {
            this.outputDebounce.delete(key);
            this.emitChange(sessionId);
          }, 500)
        );
      }
    });

    tailer.on("exit", () => {
      this.outputTailers.delete(key);
    });
  }

  private stopOutputCapture(pid: number) {
    // Stop PID-based tailer
    const pidKey = `pid:${pid}`;
    const pidTailer = this.outputTailers.get(pidKey);
    if (pidTailer) {
      pidTailer.kill();
      this.outputTailers.delete(pidKey);
    }
    const pidTimer = this.outputDebounce.get(pidKey);
    if (pidTimer) {
      clearTimeout(pidTimer);
      this.outputDebounce.delete(pidKey);
    }

    // Stop toolUseId-based tailer
    const toolUseId = this.pidToToolUseId.get(pid);
    if (toolUseId) {
      const toolTailer = this.outputTailers.get(toolUseId);
      if (toolTailer) {
        toolTailer.kill();
        this.outputTailers.delete(toolUseId);
      }
      const toolTimer = this.outputDebounce.get(toolUseId);
      if (toolTimer) {
        clearTimeout(toolTimer);
        this.outputDebounce.delete(toolUseId);
      }
      this.toolOutput.delete(toolUseId);
      this.toolOutputFiles.delete(toolUseId);
    }
  }

  stopAll() {
    this.stopScanning();
    for (const [, tailer] of this.outputTailers) {
      tailer.kill();
    }
    this.outputTailers.clear();
    for (const [, timer] of this.outputDebounce) {
      clearTimeout(timer);
    }
    this.outputDebounce.clear();
    this.sessions.clear();
    this.pidToSession.clear();
    this.pidToToolUseId.clear();
    this.baselinePids.clear();
    this.pidOutput.clear();
    this.toolOutput.clear();
    this.toolOutputFiles.clear();
  }

  // -- internal --

  private async scanListening(): Promise<ProcessInfo[]> {
    return new Promise((resolve) => {
      execFile(
        "lsof",
        ["-i", "-P", "-n", "-sTCP:LISTEN"],
        { timeout: 5000 },
        async (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }

          const pidData = new Map<
            number,
            { name: string; ports: Set<number> }
          >();
          const lines = stdout.trim().split("\n").slice(1);

          for (const line of lines) {
            const cols = line.split(/\s+/);
            if (cols.length < 9) continue;
            const name = cols[0];
            const pid = parseInt(cols[1], 10);
            const portMatch = cols[8].match(/:(\d+)$/);
            if (!portMatch) continue;
            const port = parseInt(portMatch[1], 10);
            if (IGNORED_PORTS.has(port)) continue;

            if (!pidData.has(pid))
              pidData.set(pid, { name, ports: new Set() });
            pidData.get(pid)!.ports.add(port);
          }

          const pids = Array.from(pidData.keys());
          if (pids.length === 0) {
            resolve([]);
            return;
          }
          const cmds = await this.getCommandLines(pids);

          const result: ProcessInfo[] = [];
          for (const [pid, info] of pidData) {
            result.push({
              pid,
              name: info.name,
              command: cmds.get(pid) ?? info.name,
              ports: Array.from(info.ports).sort((a, b) => a - b),
            });
          }

          resolve(result);
        }
      );
    });
  }

  private getCommandLines(pids: number[]): Promise<Map<number, string>> {
    return new Promise((resolve) => {
      execFile(
        "ps",
        ["-p", pids.join(","), "-o", "pid=,args="],
        { timeout: 5000 },
        (err, stdout) => {
          const map = new Map<number, string>();
          if (err || !stdout) {
            resolve(map);
            return;
          }
          for (const line of stdout.trim().split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m) map.set(parseInt(m[1], 10), m[2].trim());
          }
          resolve(map);
        }
      );
    });
  }

  private startScanning() {
    if (this.scanTimer) return;
    // Take an initial baseline snapshot
    this.scanListening().then((procs) => {
      this.baselinePids = new Set(procs.map((p) => p.pid));
    });
    this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
  }

  private stopScanning() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private emitChange(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Enrich commands with live output from tailed files
    const enrichedCommands = state.commands.map((cmd) => {
      const liveOutput = this.toolOutput.get(cmd.toolUseId);
      if (liveOutput) {
        return { ...cmd, output: liveOutput };
      }
      return cmd;
    });

    // Persist enriched commands so output survives restart
    state.commands = enrichedCommands;
    this.schedulePersist(sessionId);

    this.emit("change", {
      sessionId,
      state: { ...state, commands: enrichedCommands },
    });
  }

  private loadFromDisk(sessionId: string): SessionProcessState | null {
    if (!this.projectRoot) return null;
    const persisted = loadProcessSessionState(this.projectRoot, sessionId);
    if (!persisted) return null;

    // Restore PID associations only for processes that are still alive.
    // Dead PIDs drop off; their commands stay in history.
    for (const [pid, sid] of persisted.pidToSession) {
      if (sid === sessionId && isPidAlive(pid)) {
        this.pidToSession.set(pid, sid);
        this.baselinePids.add(pid);
      }
    }
    for (const [pid, toolUseId] of persisted.pidToToolUseId) {
      if (this.pidToSession.has(pid)) {
        this.pidToToolUseId.set(pid, toolUseId);
      }
    }
    return { commands: persisted.commands, processes: [] };
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
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const pidToSession: [number, string][] = [];
    const pidToToolUseId: [number, string][] = [];
    for (const [pid, sid] of this.pidToSession) {
      if (sid !== sessionId) continue;
      pidToSession.push([pid, sid]);
      const tuid = this.pidToToolUseId.get(pid);
      if (tuid) pidToToolUseId.push([pid, tuid]);
    }
    try {
      saveProcessSessionState(this.projectRoot, sessionId, {
        commands: state.commands,
        pidToSession,
        pidToToolUseId,
      });
    } catch { /* best effort */ }
  }
}
