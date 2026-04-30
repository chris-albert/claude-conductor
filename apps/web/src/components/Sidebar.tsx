import { useState, useRef, useEffect, useMemo } from "react";
import type { Session } from "../lib/types";
import { useSessionPorts } from "../lib/store";

const COLLAPSED_GROUPS_KEY = "conductor-sidebar-collapsed-groups";

interface SessionGroup {
  key: string;
  name: string;
  sessions: { session: Session; index: number }[];
}

function repoGroupFor(session: Session): { key: string; name: string } {
  // Worktrees live at <gitRoot>/.conductor/worktrees/<name> — strip that to get the repo root.
  const wt = session.worktreePath;
  if (wt) {
    const match = wt.match(/^(.*)\/\.conductor\/worktrees\/[^/]+\/?$/);
    const root = match ? match[1] : wt;
    return { key: root, name: basename(root) };
  }
  return { key: session.cwd, name: basename(session.cwd) };
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

function buildGroups(sessions: Session[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  sessions.forEach((session, index) => {
    const { key, name } = repoGroupFor(session);
    let group = map.get(key);
    if (!group) {
      group = { key, name, sessions: [] };
      map.set(key, group);
    }
    group.sessions.push({ session, index });
  });
  return Array.from(map.values());
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore
  }
  return new Set();
}

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onNewWorktree: (sourceSessionId: string) => void;
  onOpenSettings: () => void;
  onOpenProcessManager: () => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onNewWorktree,
  onOpenSettings,
  onOpenProcessManager,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsed);

  const groups = useMemo(() => buildGroups(sessions), [sessions]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <div className="w-10 bg-c-bg border-r border-c-border flex flex-col items-center flex-shrink-0">
        {/* Expand button */}
        <div className="h-9 flex items-center justify-center border-b border-c-border w-full">
          <button
            onClick={() => setCollapsed(false)}
            className="text-c-muted hover:text-c-text p-1 rounded-md hover:bg-c-surface-hover transition-colors"
            title="Expand sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        {/* New session */}
        <div className="py-2">
          <button
            onClick={onNewSession}
            className="w-7 h-7 flex items-center justify-center bg-c-accent hover:bg-c-accent-hover text-white rounded-md transition-colors"
            title="New session"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* Session dots */}
        <div className="flex-1 overflow-y-auto flex flex-col items-center gap-1 py-1">
          {sessions.map((session, i) => (
            <button
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-2xs font-mono transition-colors ${
                session.id === activeSessionId
                  ? "bg-c-surface-active text-c-text"
                  : "text-c-muted hover:bg-c-surface-hover hover:text-c-text"
              }`}
              title={session.name}
            >
              {i < 9 ? i + 1 : <StatusDot status={session.status} />}
            </button>
          ))}
        </div>

        {/* Footer actions */}
        <div className="py-2 border-t border-c-border-subtle w-full flex flex-col items-center gap-1">
          <button
            onClick={onOpenProcessManager}
            className="text-c-muted hover:text-c-text p-1 rounded-md hover:bg-c-surface-hover transition-colors"
            title="Process Manager"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          </button>
          <button
            onClick={onOpenSettings}
            className="text-c-muted hover:text-c-text p-1 rounded-md hover:bg-c-surface-hover transition-colors"
            title="Settings"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-52 bg-c-bg border-r border-c-border flex flex-col flex-shrink-0">
      {/* Header */}
      <div className="h-9 flex items-center px-3 border-b border-c-border justify-between">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded bg-c-accent flex items-center justify-center">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-c-text">Conductor</span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="text-c-muted hover:text-c-text p-1 rounded-md hover:bg-c-surface-hover transition-colors"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      {/* New session */}
      <div className="p-2">
        <button
          onClick={onNewSession}
          className="w-full h-7 flex items-center justify-center gap-1 text-xs font-medium bg-c-accent hover:bg-c-accent-hover text-white rounded-md transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New
        </button>
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {sessions.length === 0 ? (
          <p className="text-2xs text-c-muted px-2 py-3 text-center">No sessions</p>
        ) : (
          <div className="space-y-px">
            {groups.map((group) => {
              if (group.sessions.length < 2) {
                return group.sessions.map(({ session, index }) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    index={index}
                    indented={false}
                    onSelect={() => onSelectSession(session.id)}
                    onDelete={() => onDeleteSession(session.id)}
                    onRename={(name) => onRenameSession(session.id, name)}
                    onNewWorktree={() => onNewWorktree(session.id)}
                  />
                ));
              }
              const isCollapsed = collapsedGroups.has(group.key);
              return (
                <div key={group.key}>
                  <GroupHeader
                    name={group.name}
                    count={group.sessions.length}
                    collapsed={isCollapsed}
                    onToggle={() => toggleGroup(group.key)}
                  />
                  {!isCollapsed &&
                    group.sessions.map(({ session, index }) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        isActive={session.id === activeSessionId}
                        index={index}
                        indented
                        onSelect={() => onSelectSession(session.id)}
                        onDelete={() => onDeleteSession(session.id)}
                        onRename={(name) => onRenameSession(session.id, name)}
                        onNewWorktree={() => onNewWorktree(session.id)}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-c-border-subtle flex items-center justify-between text-2xs text-c-muted">
        <span>{"\u2318"}N new</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenProcessManager}
            className="text-c-muted hover:text-c-text p-1 rounded-md hover:bg-c-surface-hover transition-colors"
            title="Process Manager"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          </button>
          <button
            onClick={onOpenSettings}
            className="text-c-muted hover:text-c-text p-1 rounded-md hover:bg-c-surface-hover transition-colors"
            title="Settings"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupHeader({
  name,
  count,
  collapsed,
  onToggle,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="group w-full flex items-center gap-1 px-2 py-1 mt-1 rounded-md text-left text-c-muted hover:text-c-text-secondary hover:bg-c-surface-hover transition-colors"
      title={collapsed ? "Expand group" : "Collapse group"}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`flex-shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <span className="truncate flex-1 text-2xs font-semibold uppercase tracking-wider">
        {name}
      </span>
      <span className="text-2xs font-mono tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function SessionItem({
  session,
  isActive,
  index,
  indented,
  onSelect,
  onDelete,
  onRename,
  onNewWorktree,
}: {
  session: Session;
  isActive: boolean;
  index: number;
  indented: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onNewWorktree: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const ports = useSessionPorts(session.id);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(trimmed);
    } else {
      setDraft(session.name);
    }
    setEditing(false);
  };

  const isWorktree = !!session.worktreePath;

  return (
    <div>
      <div
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(session.name);
          setEditing(true);
        }}
        className={`group w-full flex items-center gap-1.5 ${indented ? "pl-4 pr-2" : "px-2"} py-1.5 rounded-md text-left cursor-pointer transition-colors ${
          isActive
            ? "bg-c-surface-active text-c-text"
            : "text-c-text-secondary hover:bg-c-surface-hover hover:text-c-text"
        }`}
      >
        <StatusDot status={session.status} />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(session.name); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-xs bg-c-surface border border-c-accent/50 rounded px-1 py-0 outline-none text-c-text min-w-0"
          />
        ) : (
          <span className="truncate flex-1 text-xs">{session.name}</span>
        )}
        {!editing && ports.length > 0 && (
          <span
            className="flex items-center gap-0.5 text-2xs text-c-success font-mono tabular-nums"
            title={ports.map((p) => `:${p.port}`).join(", ")}
          >
            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="flex-shrink-0">
              <circle cx="12" cy="12" r="2" />
              <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
            </svg>
            {ports.length}
          </span>
        )}
        {/* New worktree — only for sessions already using a worktree */}
        {!editing && isWorktree && (
          <span
            onClick={(e) => { e.stopPropagation(); onNewWorktree(); }}
            className="opacity-0 group-hover:opacity-100 text-c-muted hover:text-c-accent w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-c-accent-subtle"
            title="New worktree from main"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </span>
        )}
        {!editing && index < 9 && (
          <span className="text-2xs text-c-muted font-mono opacity-0 group-hover:opacity-100">
            {index + 1}
          </span>
        )}
        {!editing && (
          <span
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 text-c-muted hover:text-c-error w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-c-error-subtle"
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Session["status"] }) {
  const styles = {
    idle: "bg-c-muted/40",
    streaming: "bg-c-success animate-pulse-subtle",
    complete: "bg-c-accent",
    error: "bg-c-error",
  }[status];
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${styles}`} />;
}
