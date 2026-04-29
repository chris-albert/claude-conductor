import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentSession, type SessionEvent } from "./agent.js";
import { SessionManager } from "./sessions.js";
import { FileWatcher } from "./files.js";
import { PortMonitor } from "./ports.js";
import { ProcessManager } from "./processes.js";
import { RunnerManager } from "./runner.js";

interface ClientMessage {
  type: "start_session" | "create_session" | "kill_session" | "fork_session" | "kill_process" | "run_command" | "kill_runner";
  prompt?: string;
  sessionId?: string;
  sourceSessionId?: string;
  name?: string;
  useWorktree?: boolean;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  pid?: number;
  command?: string;
  runnerId?: string;
}

export interface WebSocketContext {
  wss: InstanceType<typeof WebSocketServer>;
  processManager: ProcessManager;
  runnerManager: RunnerManager;
}

export function setupWebSocket(
  server: HttpServer,
  sessionManager: SessionManager,
  projectRoot: string
): WebSocketContext {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const fileWatcher = new FileWatcher();
  const portMonitor = new PortMonitor();
  const processManager = new ProcessManager(5000, projectRoot);
  const runnerManager = new RunnerManager(projectRoot);

  // Persistent agent sessions — Claude Code process stays alive between prompts
  const agentSessions = new Map<string, AgentSession>();
  // Track active streaming so we can abort
  const activeAborts = new Map<string, AbortController>();

  // Start watching the project root for file changes
  fileWatcher.watchDirectory(projectRoot, "root").catch(() => {});

  fileWatcher.on("change", (event) => {
    const msg = JSON.stringify({ type: "file_change", data: event });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  portMonitor.on("change", ({ sessionId, ports }) => {
    const msg = JSON.stringify({ type: "port_change", sessionId, data: { ports } });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  processManager.on("change", ({ sessionId, state }) => {
    const msg = JSON.stringify({ type: "process_update", sessionId, data: state });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  runnerManager.on("change", ({ sessionId, state }) => {
    // Exclude runner-owned PIDs from ProcessManager scans
    processManager.excludePids = runnerManager.getRunnerPids();
    const msg = JSON.stringify({ type: "runner_update", sessionId, data: state });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  /**
   * Get or create a persistent AgentSession for a conductor session.
   * The Claude Code process stays alive across prompts so background
   * processes (dev servers, etc.) survive.
   */
  function getOrCreateAgent(sessionId: string, cwd: string): AgentSession {
    let agent = agentSessions.get(sessionId);
    if (!agent) {
      agent = new AgentSession(cwd);
      agentSessions.set(sessionId, agent);
    }
    return agent;
  }

  /**
   * Stream events from an AgentSession prompt, handling all side effects:
   * - SDK session ID capture
   * - Bash command tracking for process manager
   * - Tool result ingestion for port/process detection
   * - Event persistence to JSONL
   * - WebSocket broadcast to client
   */
  async function streamEvents(
    sessionId: string,
    prompt: string,
    ws: WebSocket,
    opts?: { model?: string; permissionMode?: string }
  ) {
    const session = sessionManager.get(sessionId);
    if (!session) return;

    const agent = getOrCreateAgent(sessionId, session.cwd);
    const ac = new AbortController();

    // Abort previous streaming for this session if any
    const prevAc = activeAborts.get(sessionId);
    if (prevAc) prevAc.abort();
    activeAborts.set(sessionId, ac);

    try {
      for await (const event of agent.sendPrompt(prompt, {
        model: opts?.model,
        permissionMode: opts?.permissionMode,
        sdkSessionId: session.sdkSessionId ?? undefined,
      })) {
        if (ac.signal.aborted) break;

        const eventData = event.data as Record<string, unknown>;

        // Capture SDK session ID
        if (eventData?.sdkSessionId && typeof eventData.sdkSessionId === "string") {
          sessionManager.setSdkSessionId(sessionId, eventData.sdkSessionId);
        }

        // Track Bash commands for process manager
        if (event.type === "tool_use") {
          const toolData = eventData;
          if (toolData?.name === "Bash" && typeof toolData.input === "object" && toolData.input) {
            const cmd = (toolData.input as Record<string, unknown>).command;
            const toolId = toolData.id as string;
            if (typeof cmd === "string" && toolId) {
              processManager.addCommand(sessionId, cmd, toolId);
            }
          }
        }

        // Feed tool results into port monitor + process manager
        if (event.type === "tool_result") {
          const content = (eventData?.content as string) ??
            (typeof event.data === "string" ? event.data : JSON.stringify(event.data));
          portMonitor.ingestToolResult(sessionId, content);
          const toolUseId = eventData?.toolUseId as string;
          if (toolUseId) {
            processManager.addCommandOutput(sessionId, toolUseId, content);
            processManager.postCommandScan(sessionId, toolUseId).catch(() => {});
          }
        }

        // Persist event
        sessionManager.appendEvent(sessionId, event);

        // Broadcast to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ...event, sessionId }));
        }
      }

      if (!ac.signal.aborted) {
        sessionManager.updateStatus(sessionId, "complete");
      }
    } catch (err) {
      sessionManager.updateStatus(sessionId, "error");
      if (ws.readyState === WebSocket.OPEN) {
        const error = err instanceof Error ? err : new Error(String(err));
        ws.send(JSON.stringify({
          type: "error",
          sessionId,
          data: { message: error.message, stack: error.stack ?? null, cwd: session.cwd },
        }));
      }
    } finally {
      activeAborts.delete(sessionId);
    }
  }

  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected");

    ws.on("message", async (data: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid JSON" } }));
        return;
      }

      // --- Create session ---
      if (msg.type === "create_session") {
        const id = msg.sessionId ?? crypto.randomUUID();
        try {
          const session = sessionManager.create(
            id,
            msg.name ?? `Session ${sessionManager.list().length}`,
            msg.useWorktree ?? false,
            msg.cwd
          );
          ws.send(JSON.stringify({ type: "session_created", data: session }));
          portMonitor.trackSession(id);
          processManager.trackSession(id);

          if (session.worktreePath) {
            fileWatcher.watchDirectory(session.worktreePath, session.id).catch(() => {});
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (msg.useWorktree) {
            try {
              const session = sessionManager.create(
                id,
                msg.name ?? `Session ${sessionManager.list().length}`,
                false,
                msg.cwd
              );
              ws.send(JSON.stringify({ type: "session_created", data: session }));
              portMonitor.trackSession(id);
              processManager.trackSession(id);
              return;
            } catch { /* fall through */ }
          }
          ws.send(JSON.stringify({ type: "error", sessionId: id, data: { message: error.message } }));
        }
        return;
      }

      // --- Fork session ---
      if (msg.type === "fork_session" && msg.sourceSessionId && msg.cwd) {
        const source = sessionManager.get(msg.sourceSessionId);
        if (!source) {
          ws.send(JSON.stringify({ type: "error", data: { message: "Source session not found" } }));
          return;
        }

        const context = sessionManager.buildContextSummary(msg.sourceSessionId);
        const id = msg.sessionId ?? crypto.randomUUID();
        const newSession = sessionManager.create(id, msg.name ?? `${source.name} (moved)`, false, msg.cwd);
        ws.send(JSON.stringify({ type: "session_created", data: newSession }));
        portMonitor.trackSession(id);
        processManager.trackSession(id);

        const contextPrompt = context + `\n\nI've moved to a new working directory: ${msg.cwd}\nPlease acknowledge the context and let me know you're ready to continue.`;

        sessionManager.updateStatus(id, "streaming");
        sessionManager.addPrompt(id, contextPrompt);
        sessionManager.appendEvent(id, { type: "user_message", data: { text: "(Context transferred from previous session)" } });
        ws.send(JSON.stringify({ type: "user_message", sessionId: id, data: { text: "(Context transferred from previous session)" } }));

        // Stream in background (don't block the message handler)
        streamEvents(id, contextPrompt, ws, {
          model: msg.model,
          permissionMode: msg.permissionMode ?? "bypassPermissions",
        });
        return;
      }

      // --- Kill session ---
      if (msg.type === "kill_session" && msg.sessionId) {
        const ac = activeAborts.get(msg.sessionId);
        if (ac) {
          ac.abort();
          activeAborts.delete(msg.sessionId);
        }
        // Close the persistent agent session (kills the Claude Code process + children)
        const agent = agentSessions.get(msg.sessionId);
        if (agent) {
          agent.close();
          agentSessions.delete(msg.sessionId);
        }
        fileWatcher.stopWatching(msg.sessionId);
        portMonitor.untrackSession(msg.sessionId);
        processManager.untrackSession(msg.sessionId);
        runnerManager.cleanupSession(msg.sessionId);
        ws.send(JSON.stringify({ type: "session_killed", data: { sessionId: msg.sessionId } }));
        return;
      }

      // --- Kill process ---
      if (msg.type === "kill_process" && msg.pid) {
        // Try runner first, then process manager
        let ok = await runnerManager.killByPid(msg.pid);
        if (!ok) ok = await processManager.killProcess(msg.pid);
        ws.send(JSON.stringify({ type: "process_killed", data: { pid: msg.pid, success: ok } }));
        return;
      }

      // --- Run command (conductor-owned) ---
      if (msg.type === "run_command" && msg.sessionId && msg.command) {
        const session = sessionManager.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", data: { message: "Session not found" } }));
          return;
        }
        const cwd = msg.cwd || session.cwd;
        const proc = runnerManager.smartSpawn(msg.sessionId, msg.command, cwd);
        ws.send(JSON.stringify({ type: "runner_spawned", sessionId: msg.sessionId, data: proc }));
        return;
      }

      // --- Kill runner process ---
      if (msg.type === "kill_runner" && msg.runnerId) {
        const ok = await runnerManager.kill(msg.runnerId);
        ws.send(JSON.stringify({ type: "runner_killed", data: { runnerId: msg.runnerId, success: ok } }));
        return;
      }

      // --- Start/continue session (send prompt) ---
      if (msg.type === "start_session" && msg.prompt && msg.sessionId) {
        const session = sessionManager.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", data: { message: `Session ${msg.sessionId} not found` } }));
          return;
        }

        sessionManager.updateStatus(msg.sessionId, "streaming");
        sessionManager.addPrompt(msg.sessionId, msg.prompt);
        sessionManager.appendEvent(msg.sessionId, { type: "user_message", data: { text: msg.prompt } });

        await streamEvents(msg.sessionId, msg.prompt, ws, {
          model: msg.model,
          permissionMode: msg.permissionMode,
        });
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
    });
  });

  // Cleanup on server shutdown
  process.on("SIGTERM", () => {
    fileWatcher.stopAll();
    portMonitor.stopAll();
    processManager.stopAll();
    runnerManager.stopAll();
    for (const [, agent] of agentSessions) agent.close();
    agentSessions.clear();
    for (const [, ac] of activeAborts) ac.abort();
  });

  return { wss, processManager, runnerManager };
}
