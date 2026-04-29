import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  Session,
  StreamEvent,
  SubagentInfo,
  SessionInfo,
  UsageData,
  PortInfo,
  SessionProcessState,
  RunnerState,
} from "./types";

interface SessionState {
  events: StreamEvent[];
  subagents: Map<string, SubagentInfo>;
  info: SessionInfo | null;
  usage: UsageData | null;
  lastCost: number | null;
  contextWindow: number | null;
  openTabs: string[];
  activeTab: string | null;
  ports: PortInfo[];
  processState: SessionProcessState;
  runnerState: RunnerState;
}

interface Store {
  sessions: Map<string, Session>;
  sessionStates: Map<string, SessionState>;
  activeSessionId: string | null;
}

type Listener = () => void;

let store: Store = {
  sessions: new Map(),
  sessionStates: new Map(),
  activeSessionId: null,
};

const listeners = new Set<Listener>();

function emitChange() {
  store = { ...store };
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return store;
}

function newSessionState(): SessionState {
  return {
    events: [],
    subagents: new Map(),
    info: null,
    usage: null,
    lastCost: null,
    contextWindow: null,
    openTabs: [],
    activeTab: null,
    ports: [],
    processState: { commands: [], processes: [] },
    runnerState: { processes: [] },
  };
}

export function useStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useActiveSession() {
  const s = useStore();
  return s.activeSessionId
    ? s.sessions.get(s.activeSessionId) ?? null
    : null;
}

export function useSessionState(sessionId: string | null) {
  const s = useStore();
  if (!sessionId) return newSessionState();
  return s.sessionStates.get(sessionId) ?? newSessionState();
}

export function useSessionPorts(sessionId: string | null): PortInfo[] {
  const s = useStore();
  if (!sessionId) return [];
  const state = s.sessionStates.get(sessionId);
  if (!state) return [];

  // Derive ports from actual process data (PID-scoped) instead of PortMonitor
  const seen = new Set<number>();
  const ports: PortInfo[] = [];

  for (const proc of state.processState?.processes ?? []) {
    for (const port of proc.ports) {
      if (!seen.has(port)) {
        seen.add(port);
        ports.push({ port, process: proc.name, pid: proc.pid, detectedFrom: "scan", detectedAt: "" });
      }
    }
  }
  for (const proc of state.runnerState?.processes ?? []) {
    if (proc.exitCode !== null) continue;
    for (const port of proc.ports) {
      if (!seen.has(port)) {
        seen.add(port);
        ports.push({ port, process: proc.command, pid: proc.pid, detectedFrom: "scan", detectedAt: "" });
      }
    }
  }

  return ports;
}

export function useSessionProcesses(sessionId: string | null): SessionProcessState {
  const s = useStore();
  if (!sessionId) return { commands: [], processes: [] };
  return s.sessionStates.get(sessionId)?.processState ?? { commands: [], processes: [] };
}

export function useRunnerState(sessionId: string | null): RunnerState {
  const s = useStore();
  if (!sessionId) return { processes: [] };
  return s.sessionStates.get(sessionId)?.runnerState ?? { processes: [] };
}

// Returns tabs for the currently active session
export function useActiveTabs() {
  const s = useStore();
  if (!s.activeSessionId) return { openTabs: [] as string[], activeTab: null as string | null };
  const state = s.sessionStates.get(s.activeSessionId);
  return {
    openTabs: state?.openTabs ?? [],
    activeTab: state?.activeTab ?? null,
  };
}

export function useSessions() {
  const s = useStore();
  return useMemo(
    () =>
      Array.from(s.sessions.values()).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [s.sessions]
  );
}

// --- Actions ---

export function setActiveSession(id: string | null) {
  store.activeSessionId = id;
  emitChange();

  if (id) {
    const state = store.sessionStates.get(id);
    // Load persisted events if this session has no events yet
    if (state && state.events.length === 0) {
      loadSessionEvents(id);
    }
    // Always fetch live process state from server memory
    loadProcessState(id);
  }
}

async function loadSessionEvents(sessionId: string) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/events`);
    const events = (await res.json()) as StreamEvent[];

    const state = store.sessionStates.get(sessionId);
    if (!state || state.events.length > 0) return; // already has events

    if (Array.isArray(events)) {
      for (const event of events) {
        addSessionEvent(sessionId, event);
      }
    }
  } catch {
    // Ignore fetch errors
  }
}

async function loadProcessState(sessionId: string) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/processes`);
    const processData = await res.json() as {
      processState?: SessionProcessState;
      runnerState?: RunnerState;
    };
    const current = store.sessionStates.get(sessionId);
    if (current) {
      store.sessionStates = new Map(store.sessionStates).set(sessionId, {
        ...current,
        processState: processData.processState ?? current.processState,
        runnerState: processData.runnerState ?? current.runnerState,
      });
      emitChange();
    }
  } catch {
    // Process endpoint may not exist on older servers
  }
}

export function openFile(path: string) {
  const sid = store.activeSessionId;
  if (!sid) return;
  const state = store.sessionStates.get(sid);
  if (!state) return;
  const tabs = state.openTabs.includes(path)
    ? state.openTabs
    : [...state.openTabs, path];
  store.sessionStates = new Map(store.sessionStates).set(sid, {
    ...state,
    openTabs: tabs,
    activeTab: path,
  });
  emitChange();
}

export function renameSession(id: string, name: string) {
  const session = store.sessions.get(id);
  if (!session) return;
  store.sessions = new Map(store.sessions).set(id, { ...session, name });
  emitChange();
}

export function updateSessionCwd(id: string, cwd: string) {
  const session = store.sessions.get(id);
  if (!session) return;
  store.sessions = new Map(store.sessions).set(id, { ...session, cwd });
  emitChange();
}

export function closeTab(path: string) {
  const sid = store.activeSessionId;
  if (!sid) return;
  const state = store.sessionStates.get(sid);
  if (!state) return;
  const tabs = state.openTabs.filter((t) => t !== path);
  store.sessionStates = new Map(store.sessionStates).set(sid, {
    ...state,
    openTabs: tabs,
    activeTab:
      state.activeTab === path
        ? tabs.length > 0
          ? tabs[tabs.length - 1]
          : null
        : state.activeTab,
  });
  emitChange();
}

export function setActiveTab(path: string) {
  const sid = store.activeSessionId;
  if (!sid) return;
  const state = store.sessionStates.get(sid);
  if (!state) return;
  store.sessionStates = new Map(store.sessionStates).set(sid, {
    ...state,
    activeTab: path,
  });
  emitChange();
}

export function addSession(session: Session) {
  store.sessions = new Map(store.sessions).set(session.id, session);
  store.sessionStates = new Map(store.sessionStates).set(
    session.id,
    newSessionState()
  );
  emitChange();
}

export function removeSession(id: string) {
  const sessions = new Map(store.sessions);
  sessions.delete(id);
  store.sessions = sessions;
  const states = new Map(store.sessionStates);
  states.delete(id);
  store.sessionStates = states;
  if (store.activeSessionId === id) {
    store.activeSessionId =
      sessions.size > 0 ? sessions.keys().next().value ?? null : null;
  }
  emitChange();
}

export function updateSessionStatus(id: string, status: Session["status"]) {
  const session = store.sessions.get(id);
  if (!session) return;
  store.sessions = new Map(store.sessions).set(id, { ...session, status });
  emitChange();
}

export function addSessionEvent(sessionId: string, event: StreamEvent) {
  const state = store.sessionStates.get(sessionId);
  if (!state) return;

  if (event.type === "session_info") {
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      info: event.data as SessionInfo,
    });
    emitChange();
    return;
  }

  if (event.type === "usage_update") {
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      usage: event.data as UsageData,
    });
    emitChange();
    return;
  }

  if (event.type === "port_change") {
    const d = event.data as { ports: PortInfo[] };
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      ports: d.ports,
    });
    emitChange();
    return;
  }

  if (event.type === "process_update") {
    const d = event.data as SessionProcessState;
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      processState: d,
    });
    emitChange();
    return;
  }

  if (event.type === "runner_update") {
    const d = event.data as RunnerState;
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      runnerState: d,
    });
    emitChange();
    return;
  }

  if (event.type === "session_complete") {
    const d = event.data as Record<string, unknown>;
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      events: [...state.events, event],
      lastCost: (d.cost as number) ?? state.lastCost,
      contextWindow: (d.contextWindow as number) ?? state.contextWindow,
    });
    emitChange();
    return;
  }

  const toolData = event.data as Record<string, unknown> | undefined;
  const parentToolUseId = toolData?.parentToolUseId as string | undefined;

  if (parentToolUseId) {
    const subagents = new Map(state.subagents);
    const existing = subagents.get(parentToolUseId);
    if (existing) {
      subagents.set(parentToolUseId, {
        ...existing,
        events: [...existing.events, event],
        status: existing.status,
      });
    } else {
      subagents.set(parentToolUseId, {
        parentToolUseId,
        agentType: (toolData?.name as string) ?? "Agent",
        events: [event],
        status: "active",
      });
    }
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      subagents,
    });
  } else {
    store.sessionStates = new Map(store.sessionStates).set(sessionId, {
      ...state,
      events: [...state.events, event],
    });
  }
  emitChange();
}

export function loadSessions(sessions: Session[]) {
  const map = new Map<string, Session>();
  const states = new Map<string, SessionState>(store.sessionStates);
  for (const s of sessions) {
    map.set(s.id, s);
    if (!states.has(s.id)) states.set(s.id, newSessionState());
  }
  store.sessions = map;
  store.sessionStates = states;
  emitChange();
}

// --- WebSocket ---

let ws: WebSocket | null = null;

export function useWebSocket() {
  const connect = useCallback(() => {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (e) => {
      try {
        const event: StreamEvent = JSON.parse(e.data);
        const sessionId = event.sessionId;

        if (event.type === "session_created") {
          addSession(event.data as Session);
          setActiveSession((event.data as Session).id);
        } else if (event.type === "file_change") {
          emitChange();
        } else if (event.type === "session_complete") {
          if (sessionId) updateSessionStatus(sessionId, "complete");
          if (sessionId) addSessionEvent(sessionId, event);
        } else if (event.type === "error") {
          if (sessionId) {
            updateSessionStatus(sessionId, "error");
            addSessionEvent(sessionId, event);
          } else {
            // Error without a session (e.g. session creation failed)
            const msg = (event.data as Record<string, string>)?.message;
            if (msg) console.error("[server]", msg);
          }
        } else if (sessionId) {
          addSessionEvent(sessionId, event);
        }
      } catch {
        // Ignore
      }
    };

    ws.onclose = () => {
      setTimeout(connect, 2000);
    };
  }, []);

  const send = useCallback((msg: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { connect, send };
}
