import { execFile } from "child_process";
import { EventEmitter } from "events";

export interface PortInfo {
  port: number;
  process: string;
  pid: number;
  detectedFrom: "output" | "scan";
  detectedAt: string;
}

/**
 * Regex patterns that match common "server listening" output lines.
 * Each pattern should capture the port number in group 1.
 */
const PORT_PATTERNS: RegExp[] = [
  /(?:listening|running|started|served?|available|ready)\s+(?:on|at)\s+(?:(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])[:\s]+)?(?::?\s*)(\d{2,5})/gi,
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/gi,
  /port\s+(\d{2,5})/gi,
  /:\s*(\d{4,5})\s*$/gm,
];

/** Ports we never care about (system / noise) */
const IGNORED_PORTS = new Set([22, 53, 80, 443, 3001]);

function isValidPort(port: number): boolean {
  return port >= 1024 && port <= 65535 && !IGNORED_PORTS.has(port);
}

/**
 * Extract port numbers from a text string (e.g. tool_result output).
 */
export function extractPortsFromText(text: string): number[] {
  const found = new Set<number>();
  for (const pattern of PORT_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const port = parseInt(match[1], 10);
      if (isValidPort(port)) found.add(port);
    }
  }
  return Array.from(found);
}

/**
 * Scan the system for TCP LISTEN sockets using lsof.
 * Returns all listening ports with their process info.
 */
function scanListeningPorts(): Promise<PortInfo[]> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-i", "-P", "-n", "-sTCP:LISTEN"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }

        const ports: PortInfo[] = [];
        const seen = new Set<number>();
        const lines = stdout.trim().split("\n").slice(1); // skip header

        for (const line of lines) {
          const cols = line.split(/\s+/);
          if (cols.length < 9) continue;

          const processName = cols[0];
          const pid = parseInt(cols[1], 10);
          const nameField = cols[8]; // e.g. *:3000 or 127.0.0.1:8080

          const portMatch = nameField.match(/:(\d+)$/);
          if (!portMatch) continue;

          const port = parseInt(portMatch[1], 10);
          if (!isValidPort(port) || seen.has(port)) continue;
          seen.add(port);

          ports.push({
            port,
            process: processName,
            pid,
            detectedFrom: "scan",
            detectedAt: new Date().toISOString(),
          });
        }
        resolve(ports);
      }
    );
  });
}

/**
 * Monitors ports opened by a session.
 *
 * Two detection mechanisms:
 * 1. Output parsing — instant, called when tool_result events arrive
 * 2. Periodic lsof scan — catches ports not mentioned in output
 *
 * Emits "change" with { sessionId, ports: PortInfo[] } when the set changes.
 */
export class PortMonitor extends EventEmitter {
  private sessionPorts = new Map<string, Map<number, PortInfo>>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanIntervalMs: number;

  constructor(scanIntervalMs = 5000) {
    super();
    this.scanIntervalMs = scanIntervalMs;
  }

  /** Register a session for port tracking */
  trackSession(sessionId: string) {
    if (!this.sessionPorts.has(sessionId)) {
      this.sessionPorts.set(sessionId, new Map());
    }
    this.startScanning();
  }

  /** Stop tracking a session */
  untrackSession(sessionId: string) {
    this.sessionPorts.delete(sessionId);
    if (this.sessionPorts.size === 0) {
      this.stopScanning();
    }
  }

  /**
   * Feed tool_result output from a session to detect ports.
   * Called from the event stream handler.
   */
  ingestToolResult(sessionId: string, text: string) {
    const ports = extractPortsFromText(text);
    if (ports.length === 0) return;

    const portMap = this.sessionPorts.get(sessionId);
    if (!portMap) return;

    let changed = false;
    for (const port of ports) {
      if (!portMap.has(port)) {
        portMap.set(port, {
          port,
          process: "unknown",
          pid: 0,
          detectedFrom: "output",
          detectedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }

    if (changed) {
      this.emitPortChange(sessionId);
    }
  }

  /** Get current ports for a session */
  getPorts(sessionId: string): PortInfo[] {
    const portMap = this.sessionPorts.get(sessionId);
    return portMap ? Array.from(portMap.values()) : [];
  }

  /** Get all ports across all sessions */
  getAllPorts(): Map<string, PortInfo[]> {
    const result = new Map<string, PortInfo[]>();
    for (const [sid, portMap] of this.sessionPorts) {
      result.set(sid, Array.from(portMap.values()));
    }
    return result;
  }

  /** Run a one-time scan and update all sessions with discovered ports */
  async scan() {
    const listening = await scanListeningPorts();
    const listeningSet = new Set(listening.map((p) => p.port));
    const listeningMap = new Map(listening.map((p) => [p.port, p]));

    for (const [sessionId, portMap] of this.sessionPorts) {
      let changed = false;

      // Remove ports that are no longer listening
      for (const port of portMap.keys()) {
        if (!listeningSet.has(port)) {
          portMap.delete(port);
          changed = true;
        }
      }

      // Enrich output-detected ports with process info from scan
      for (const [port, info] of portMap) {
        const scanned = listeningMap.get(port);
        if (scanned && info.process === "unknown") {
          info.process = scanned.process;
          info.pid = scanned.pid;
          changed = true;
        }
      }

      if (changed) {
        this.emitPortChange(sessionId);
      }
    }
  }

  stopAll() {
    this.stopScanning();
    this.sessionPorts.clear();
  }

  private startScanning() {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
    // Run an initial scan immediately
    this.scan();
  }

  private stopScanning() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private emitPortChange(sessionId: string) {
    this.emit("change", {
      sessionId,
      ports: this.getPorts(sessionId),
    });
  }
}
