import { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { SessionPane } from "./components/SessionPane";
import { ProcessPanel } from "./components/ProcessPanel";
import { BrowserPanel } from "./components/BrowserPanel";
import { SettingsModal } from "./components/SettingsModal";
import { NewSessionModal } from "./components/NewSessionModal";
import {
  useStore,
  useSessions,
  useActiveSession,
  useWebSocket,
  setActiveSession,
  loadSessions,
  removeSession,
  updateSessionStatus,
  addSessionEvent,
  renameSession,
} from "./lib/store";
import { useSettings } from "./lib/settings";

export default function App() {
  const store = useStore();
  const sessions = useSessions();
  const activeSession = useActiveSession();
  const { connect, send } = useWebSocket();
  const settings = useSettings();
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [leftTab, setLeftTab] = useState<"explorer" | "processes" | "browser">("explorer");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [authState, setAuthState] = useState<{
    checked: boolean;
    authenticated: boolean;
    loading: boolean;
    error: string | null;
  }>({ checked: false, authenticated: false, loading: false, error: null });

  // Check auth status on mount
  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data) => {
        setAuthState((prev) => ({ ...prev, checked: true, authenticated: data.authenticated }));
      })
      .catch(() => {
        setAuthState((prev) => ({ ...prev, checked: true }));
      });
  }, []);

  const handleSubmitApiKey = useCallback(() => {
    if (!apiKeyInput.trim()) return;
    setAuthState((prev) => ({ ...prev, loading: true, error: null }));
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (data.authenticated) {
          setAuthState((prev) => ({ ...prev, authenticated: true, loading: false }));
          setApiKeyInput("");
        } else {
          setAuthState((prev) => ({ ...prev, loading: false, error: data.error || "Authentication failed" }));
        }
      })
      .catch(() => {
        setAuthState((prev) => ({ ...prev, loading: false, error: "Failed to save API key" }));
      });
  }, [apiKeyInput]);

  // Connect WebSocket + load existing sessions + config on mount
  useEffect(() => {
    connect();
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => loadSessions(data))
      .catch(() => {});
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setProjectRoot(data.projectRoot))
      .catch(() => {});
  }, [connect]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        // Cmd+,: settings
        if (e.key === ",") {
          e.preventDefault();
          setSettingsOpen((o) => !o);
          return;
        }
        // Cmd+N: new session
        if (e.key === "n") {
          e.preventDefault();
          setNewSessionOpen(true);
          return;
        }
        // Cmd+1-9: switch session
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9 && sessions.length >= num) {
          e.preventDefault();
          setActiveSession(sessions[num - 1].id);
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessions]);

  const handleNewSession = useCallback(
    (opts: { name: string; cwd?: string; useWorktree: boolean }) => {
      const id = crypto.randomUUID();
      send({
        type: "create_session",
        sessionId: id,
        name: opts.name,
        useWorktree: opts.useWorktree,
        cwd: opts.cwd || undefined,
      });
    },
    [send]
  );

  const handleDeleteSession = useCallback(
    (id: string) => {
      send({ type: "kill_session", sessionId: id });
      removeSession(id);
      fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    },
    [send]
  );

  const handleRenameSession = useCallback(
    (id: string, name: string) => {
      renameSession(id, name);
      fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => {});
    },
    []
  );

  const handleNewWorktree = useCallback(
    (sourceSessionId: string) => {
      // Derive the git root from the source session's worktree path
      // worktreePath is like <gitRoot>/.conductor/worktrees/<name>
      const source = store.sessions.get(sourceSessionId);
      if (!source?.worktreePath) return;
      const gitRoot = source.worktreePath.replace(/\/\.conductor\/worktrees\/[^/]+$/, "");

      const id = crypto.randomUUID();
      const num = sessions.length + 1;
      send({
        type: "create_session",
        sessionId: id,
        name: `Session ${num}`,
        useWorktree: true,
        cwd: gitRoot,
      });
    },
    [send, sessions.length, store.sessions]
  );

  const handleSendPrompt = useCallback(
    (sessionId: string, prompt: string, model?: string, permissionMode?: string) => {
      addSessionEvent(sessionId, {
        type: "user_message",
        data: { text: prompt },
      });
      updateSessionStatus(sessionId, "streaming");
      send({
        type: "start_session",
        sessionId,
        prompt,
        model,
        permissionMode,
      });
    },
    [send]
  );

  return (
    <div
      className="relative flex h-full"
      style={{ backgroundColor: settings.backgroundColor }}
    >
      {/* Background image layer — sits between solid color and UI panels */}
      {settings.backgroundImage && (
        <div
          className="fixed inset-0 z-0 bg-cover bg-center bg-no-repeat pointer-events-none"
          style={{
            backgroundImage: `url(${settings.backgroundImage})`,
            opacity: settings.backgroundImageOpacity,
          }}
        />
      )}

      {/* UI content — above the image layer */}
      <div className="relative z-10 flex h-full w-full">

      {/* Modals */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} projectRoot={projectRoot} />
      <NewSessionModal
        open={newSessionOpen}
        projectRoot={projectRoot}
        sessionCount={sessions.length}
        onClose={() => setNewSessionOpen(false)}
        onCreate={handleNewSession}
      />

      {/* Auth modal */}
      {authState.checked && !authState.authenticated && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[420px] border border-c-border rounded-xl shadow-2xl overflow-hidden" style={{ backgroundColor: "#1a1a24" }}>
            <div className="px-6 py-5">
              <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-c-surface flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-c-accent">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h2 className="text-base font-semibold text-c-text text-center mb-1">Connect to Claude</h2>
              <p className="text-xs text-c-muted text-center mb-5">
                Enter your Anthropic API key to start using Conductor.
              </p>
              <div className="space-y-3">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSubmitApiKey(); }}
                  placeholder="sk-ant-..."
                  autoFocus
                  className="w-full text-sm font-mono bg-c-surface border border-c-border rounded-md px-3 py-2 text-c-text outline-none focus:border-c-accent/50"
                />
                <button
                  onClick={handleSubmitApiKey}
                  disabled={authState.loading || !apiKeyInput.trim()}
                  className="w-full px-4 py-2.5 text-sm font-medium bg-c-accent hover:bg-c-accent-hover disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  {authState.loading ? "Saving..." : "Connect"}
                </button>
                {authState.error && (
                  <p className="text-xs text-red-400 text-center">{authState.error}</p>
                )}
                <p className="text-2xs text-c-muted text-center">
                  Your key is stored locally in the Docker volume and never leaves the server.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        activeSessionId={store.activeSessionId}
        onSelectSession={setActiveSession}
        onNewSession={() => setNewSessionOpen(true)}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onNewWorktree={handleNewWorktree}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main content area: split pane */}
      <div className="flex flex-1 min-w-0">
        {/* Left: Tabbed (Explorer / Processes) */}
        <div className="w-1/2 border-r border-c-border flex flex-col">
          {/* Tab bar */}
          <div className="h-7 flex items-center border-b border-c-border flex-shrink-0">
            <button
              onClick={() => setLeftTab("explorer")}
              className={`h-full px-3 text-2xs font-medium uppercase tracking-wider transition-colors border-b-2 ${
                leftTab === "explorer"
                  ? "text-c-text-secondary border-c-accent"
                  : "text-c-muted border-transparent hover:text-c-text-secondary"
              }`}
            >
              Explorer
            </button>
            <button
              onClick={() => setLeftTab("processes")}
              className={`h-full px-3 text-2xs font-medium uppercase tracking-wider transition-colors border-b-2 ${
                leftTab === "processes"
                  ? "text-c-text-secondary border-c-accent"
                  : "text-c-muted border-transparent hover:text-c-text-secondary"
              }`}
            >
              Processes
            </button>
            <button
              onClick={() => setLeftTab("browser")}
              className={`h-full px-3 text-2xs font-medium uppercase tracking-wider transition-colors border-b-2 ${
                leftTab === "browser"
                  ? "text-c-text-secondary border-c-accent"
                  : "text-c-muted border-transparent hover:text-c-text-secondary"
              }`}
            >
              Browser
            </button>
          </div>
          {/* Tab content */}
          <div className="flex-1 min-h-0">
            {leftTab === "explorer" ? (
              <EditorPane rootPath={activeSession?.cwd ?? projectRoot} />
            ) : leftTab === "processes" ? (
              activeSession ? (
                <ProcessPanel
                  sessionId={activeSession.id}
                  onKillProcess={(pid) => send({ type: "kill_process", pid })}
                  onRunCommand={(command) => send({ type: "run_command", sessionId: activeSession.id, command })}
                  onKillRunner={(runnerId) => send({ type: "kill_runner", runnerId })}
                />
              ) : (
                <div className="flex items-center justify-center h-full bg-c-bg">
                  <p className="text-xs text-c-muted">Select a session to view processes</p>
                </div>
              )
            ) : activeSession ? (
              <BrowserPanel sessionId={activeSession.id} />
            ) : (
              <div className="flex items-center justify-center h-full bg-c-bg">
                <p className="text-xs text-c-muted">Select a session to view browser</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Session stream */}
        <div className="w-1/2">
          {activeSession ? (
            <SessionPane
              sessionId={activeSession.id}
              onSendPrompt={handleSendPrompt}
              onRunCommand={(command) => send({ type: "run_command", sessionId: activeSession.id, command })}
              isStreaming={activeSession.status === "streaming"}
            />
          ) : (
            <div className="flex items-center justify-center h-full bg-c-bg">
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-c-surface flex items-center justify-center">
                  <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="text-c-accent"
                  >
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-c-text mb-1.5">
                  Claude Conductor
                </h2>
                <p className="text-sm text-c-muted mb-6">
                  Orchestrate parallel Claude sessions
                </p>
                <button
                  onClick={() => setNewSessionOpen(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-c-accent hover:bg-c-accent-hover text-sm font-medium text-white rounded-lg transition-colors"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New Session
                </button>
                <p className="text-2xs text-c-muted mt-4">
                  or press{" "}
                  <kbd className="px-1.5 py-0.5 bg-c-surface rounded text-2xs font-mono">
                    {"\u2318"}N
                  </kbd>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
