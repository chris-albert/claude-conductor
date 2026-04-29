import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "fs";

const CONDUCTOR_CLAUDE_MD = `# Conductor Process Management

## IMPORTANT: Do NOT start long-running processes

Do NOT use the Bash tool to start dev servers, watchers, or any long-running process.
They will be automatically killed when the tool completes.

Instead, when the user asks you to start a server or long-running process:
1. Tell the user the exact command to run (e.g. \`pnpm dev\`, \`npm run dev\`)
2. Explain that they should run it via the **Processes panel** in the Conductor UI
3. You can verify it's running afterward by checking if the port is in use

Short-lived commands (install, build, git, file operations, tests) are fine to run directly.
`;
import { join } from "path";
import { createWorktree, removeWorktree } from "./worktrees.js";
import {
  deleteProcessSessionState,
  deleteRunnerSessionState,
} from "./persistence.js";

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

const SESSIONS_FILE = ".conductor/sessions.json";
const EVENTS_DIR = ".conductor/events";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.load();
  }

  create(id: string, name: string, useWorktree: boolean, customCwd?: string): Session {
    let worktreePath: string | null = null;
    let cwd = customCwd || this.projectRoot;

    if (useWorktree) {
      // Create worktree from the chosen directory (which must be a git repo)
      const gitRoot = customCwd || this.projectRoot;
      worktreePath = createWorktree(gitRoot, id.slice(0, 8));
      cwd = worktreePath;
    }

    const session: Session = {
      id,
      name,
      cwd,
      worktreePath,
      createdAt: new Date().toISOString(),
      status: "idle",
      promptHistory: [],
      sdkSessionId: null,
    };

    this.sessions.set(id, session);
    this.save();

    // Write CLAUDE.md to instruct Claude about process management
    this.ensureClaudeMd(cwd);

    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  updateStatus(id: string, status: Session["status"]) {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      this.save();
    }
  }

  setSdkSessionId(id: string, sdkSessionId: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.sdkSessionId = sdkSessionId;
      this.save();
    }
  }

  addPrompt(id: string, prompt: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.promptHistory.push(prompt);
      this.save();
    }
  }

  rename(id: string, name: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.name = name;
      this.save();
    }
  }

  updateCwd(id: string, cwd: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.cwd = cwd;
      // Invalidate the SDK session ID — it's tied to the old cwd
      session.sdkSessionId = null;
      this.save();
    }
  }

  appendEvent(id: string, event: unknown) {
    const dir = join(this.projectRoot, EVENTS_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${id}.jsonl`);
    appendFileSync(filePath, JSON.stringify(event) + "\n");
  }

  getEvents(id: string): unknown[] {
    const filePath = join(this.projectRoot, EVENTS_DIR, `${id}.jsonl`);
    if (!existsSync(filePath)) return [];
    try {
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      return lines.filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  remove(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.worktreePath) {
      try {
        removeWorktree(this.projectRoot, id.slice(0, 8));
      } catch {
        // Best effort cleanup
      }
    }

    // Clean up events file
    const eventsFile = join(this.projectRoot, EVENTS_DIR, `${id}.jsonl`);
    try {
      if (existsSync(eventsFile)) unlinkSync(eventsFile);
    } catch {
      // Best effort
    }

    // Clean up persisted process/runner history
    deleteProcessSessionState(this.projectRoot, id);
    deleteRunnerSessionState(this.projectRoot, id);

    this.sessions.delete(id);
    this.save();
  }

  buildContextSummary(id: string): string {
    const events = this.getEvents(id);
    const session = this.sessions.get(id);
    const parts: string[] = [];

    parts.push(
      `This session continues from a previous conversation${session ? ` that was working in ${session.cwd}` : ""}.`,
      `Below is the full conversation history. Please continue from where we left off.\n`,
      `<previous_conversation>`
    );

    for (const raw of events) {
      const event = raw as { type: string; data: Record<string, unknown> };

      if (event.type === "user_message") {
        parts.push(`\n[User]\n${event.data.text}`);
      } else if (event.type === "message") {
        parts.push(`\n[Assistant]\n${event.data.text}`);
      } else if (event.type === "tool_use") {
        const input =
          typeof event.data.input === "string"
            ? event.data.input
            : JSON.stringify(event.data.input, null, 2);
        // Truncate very large tool inputs
        const truncated =
          input.length > 2000 ? input.slice(0, 2000) + "\n... (truncated)" : input;
        parts.push(`\n[Tool Use: ${event.data.name}]\n${truncated}`);
      } else if (event.type === "tool_result") {
        const content =
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data, null, 2);
        const truncated =
          content.length > 2000
            ? content.slice(0, 2000) + "\n... (truncated)"
            : content;
        parts.push(`\n[Tool Result]\n${truncated}`);
      }
    }

    parts.push(`\n</previous_conversation>`);

    return parts.join("\n");
  }

  private ensureClaudeMd(cwd: string) {
    try {
      const mdPath = join(cwd, "CLAUDE.md");
      if (existsSync(mdPath)) {
        // Append our section if not already present
        const existing = readFileSync(mdPath, "utf-8");
        if (!existing.includes("Conductor Process Management")) {
          writeFileSync(mdPath, existing + "\n\n" + CONDUCTOR_CLAUDE_MD);
        }
      } else {
        writeFileSync(mdPath, CONDUCTOR_CLAUDE_MD);
      }
    } catch {
      // Best effort — don't fail session creation if we can't write
    }
  }

  private save() {
    const dir = join(this.projectRoot, ".conductor");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = Object.fromEntries(this.sessions);
    writeFileSync(
      join(this.projectRoot, SESSIONS_FILE),
      JSON.stringify(data, null, 2)
    );
  }

  private load() {
    const filePath = join(this.projectRoot, SESSIONS_FILE);
    if (!existsSync(filePath)) return;

    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      for (const [id, session] of Object.entries(data)) {
        const s = session as Session;
        // Reset streaming sessions to idle on reload
        if (s.status === "streaming") s.status = "idle";
        this.sessions.set(id, s);
      }
    } catch {
      // Corrupted file, start fresh
    }
  }
}
