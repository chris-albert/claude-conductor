import express from "express";
import cors from "cors";
import { createServer, Server } from "http";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { setupWebSocket } from "./ws.js";
import { SessionManager } from "./sessions.js";
import { listDirectory, readFileContent, writeFileContent, getFileStats } from "./files.js";

export interface ConductorServerOptions {
  projectRoot?: string;
  port?: number;
  /** Directory containing built web app to serve statically */
  staticDir?: string;
}

export interface ConductorServer {
  server: Server;
  start: () => Promise<{ port: number }>;
}

export function createConductorServer(
  opts: ConductorServerOptions = {}
): ConductorServer {
  const PROJECT_ROOT = opts.projectRoot || process.env.PROJECT_ROOT || process.cwd();
  const sessionManager = new SessionManager(PROJECT_ROOT);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check + config
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/config", (_req, res) => {
    res.json({ projectRoot: PROJECT_ROOT });
  });

  // Session endpoints
  app.get("/api/sessions", (_req, res) => {
    res.json(sessionManager.list());
  });

  app.post("/api/sessions", (req, res) => {
    const { id, name, useWorktree } = req.body;
    const session = sessionManager.create(
      id ?? crypto.randomUUID(),
      name ?? `Session ${sessionManager.list().length + 1}`,
      useWorktree ?? false
    );
    res.json(session);
  });

  app.delete("/api/sessions/:id", (req, res) => {
    sessionManager.remove(req.params.id);
    res.json({ ok: true });
  });

  app.patch("/api/sessions/:id", (req, res) => {
    const { name, cwd } = req.body;
    if (name) sessionManager.rename(req.params.id, name);
    if (cwd) sessionManager.updateCwd(req.params.id, cwd);
    res.json(sessionManager.get(req.params.id));
  });

  app.get("/api/sessions/:id/events", (req, res) => {
    const events = sessionManager.getEvents(req.params.id);
    res.json(events);
  });

  // Git check endpoint
  app.get("/api/git/check", (req, res) => {
    const dirPath = req.query.path as string;
    if (!dirPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: dirPath,
        stdio: "pipe",
      });
      res.json({ isGitRepo: true });
    } catch {
      res.json({ isGitRepo: false });
    }
  });

  // File system endpoints
  app.get("/api/files/list", async (req, res) => {
    try {
      const dirPath = (req.query.path as string) || PROJECT_ROOT;
      const entries = await listDirectory(dirPath);
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/files/read", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path is required" });
        return;
      }
      const result = await readFileContent(filePath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/files/dirs", async (req, res) => {
    try {
      const input = (req.query.path as string) || PROJECT_ROOT;
      const { dirname, basename: pathBasename } = await import("path");
      const parentDir = input.endsWith("/") ? input : dirname(input);
      const prefix = input.endsWith("/") ? "" : pathBasename(input).toLowerCase();

      const { readdir } = await import("fs/promises");
      const entries = await readdir(parentDir, { withFileTypes: true });
      const dirs = entries
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.name.startsWith(".") &&
            e.name !== "node_modules" &&
            e.name.toLowerCase().startsWith(prefix)
        )
        .map((e) => ({
          name: e.name,
          path: parentDir.endsWith("/")
            ? parentDir + e.name
            : parentDir + "/" + e.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);

      res.json(dirs);
    } catch {
      res.json([]);
    }
  });

  app.put("/api/files/write", async (req, res) => {
    try {
      const { path: filePath, content } = req.body;
      if (!filePath || typeof content !== "string") {
        res.status(400).json({ error: "path and content are required" });
        return;
      }
      await writeFileContent(filePath, content);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/files/stat", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path is required" });
        return;
      }
      const result = await getFileStats(filePath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Auth — check native Claude Code credentials first, then API key fallback
  const API_KEY_PATH = join(
    process.env.HOME || process.env.USERPROFILE || "/home/conductor",
    ".claude",
    ".api-key"
  );

  function checkNativeAuth(): boolean {
    try {
      const result = execSync("claude auth status", {
        encoding: "utf-8",
        stdio: "pipe",
        env: { ...process.env, BROWSER: "echo" },
      });
      return result.includes('"loggedIn": true') || result.includes("loggedIn");
    } catch (e) {
      // claude auth status outputs JSON to stderr on failure
      const stderr = (e as { stderr?: string }).stderr ?? "";
      return stderr.includes('"loggedIn": true');
    }
  }

  function loadApiKey(): string | null {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    try {
      if (existsSync(API_KEY_PATH)) {
        const key = readFileSync(API_KEY_PATH, "utf-8").trim();
        if (key) {
          process.env.ANTHROPIC_API_KEY = key;
          return key;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  // Load API key on startup
  loadApiKey();

  app.get("/api/auth/status", (_req, res) => {
    // Native Claude Code auth takes priority
    const nativeAuth = checkNativeAuth();
    if (nativeAuth) {
      res.json({ authenticated: true, method: "oauth" });
      return;
    }
    const key = loadApiKey();
    res.json({ authenticated: !!key, method: key ? "api-key" : "none" });
  });

  app.post("/api/auth/login", (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== "string" || !apiKey.startsWith("sk-ant-")) {
      res.status(400).json({ error: "A valid Anthropic API key is required (starts with sk-ant-)" });
      return;
    }
    try {
      const dir = join(
        process.env.HOME || process.env.USERPROFILE || "/home/conductor",
        ".claude"
      );
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(API_KEY_PATH, apiKey.trim(), { mode: 0o600 });
      process.env.ANTHROPIC_API_KEY = apiKey.trim();
      res.json({ authenticated: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/auth/logout", (_req, res) => {
    try {
      if (existsSync(API_KEY_PATH)) {
        writeFileSync(API_KEY_PATH, "", { mode: 0o600 });
      }
      delete process.env.ANTHROPIC_API_KEY;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Setup WebSocket (must happen before static serving so we can add API routes)
  const server = createServer(app);
  const { processManager, runnerManager } = setupWebSocket(server, sessionManager, PROJECT_ROOT);

  // Live process/runner state (in-memory, survives page refresh but not server restart)
  app.get("/api/sessions/:id/processes", (req, res) => {
    res.json({
      processState: processManager.getState(req.params.id),
      runnerState: runnerManager.getState(req.params.id),
    });
  });

  // Serve static web app if a directory is provided (used by Electron / standalone)
  // Must be AFTER all API routes since the catch-all "*" would intercept them
  if (opts.staticDir) {
    app.use(express.static(opts.staticDir));
    app.get("*", (_req, res) => {
      res.sendFile(join(opts.staticDir!, "index.html"));
    });
  }

  const start = (): Promise<{ port: number }> =>
    new Promise((resolve) => {
      const port = opts.port ?? 3001;
      server.listen(port, () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        console.log(`Claude Conductor server listening on http://localhost:${actualPort}`);
        console.log(`Project root: ${PROJECT_ROOT}`);
        resolve({ port: actualPort });
      });
    });

  return { server, start };
}
