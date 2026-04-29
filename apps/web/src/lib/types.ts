export interface Session {
  id: string;
  name: string;
  cwd: string;
  worktreePath: string | null;
  createdAt: string;
  status: "idle" | "streaming" | "complete" | "error";
  promptHistory: string[];
  sdkSessionId: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface StreamEvent {
  type:
    | "user_message"
    | "message"
    | "tool_use"
    | "tool_result"
    | "error"
    | "session_complete"
    | "session_created"
    | "session_killed"
    | "session_info"
    | "usage_update"
    | "file_change"
    | "subagent_start"
    | "subagent_message"
    | "subagent_complete"
    | "auth_status"
    | "port_change"
    | "process_update"
    | "runner_update";
  sessionId?: string;
  data: unknown;
}

export interface SessionInfo {
  model: string;
  tools: string[];
  cwd: string;
  version: string;
  sdkSessionId?: string;
}

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
}

export interface SubagentInfo {
  parentToolUseId: string;
  agentType?: string;
  events: StreamEvent[];
  status: "active" | "complete";
}

export interface PortInfo {
  port: number;
  process: string;
  pid: number;
  detectedFrom: "output" | "scan";
  detectedAt: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
  ports: number[];
  output?: string;
}

export interface TrackedCommand {
  command: string;
  timestamp: string;
  toolUseId: string;
  output?: string;
}

export interface SessionProcessState {
  commands: TrackedCommand[];
  processes: ProcessInfo[];
}

export interface PortSlot {
  name: string;
  port: number;
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
  /** Ports conductor allocated and injected as env vars (PORT, WEB_PORT, etc). */
  slots: PortSlot[];
  output: string;
  exitCode: number | null;
}

export interface RunnerState {
  processes: RunnerProcess[];
}
