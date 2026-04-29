import { useEffect, useState, useCallback } from "react";
import type { RunnerProcess, Session } from "../lib/types";

interface ProcessManagerModalProps {
  open: boolean;
  sessions: Session[];
  onClose: () => void;
  onKillRunner: (runnerId: string) => void;
}

export function ProcessManagerModal({
  open,
  sessions,
  onClose,
  onKillRunner,
}: ProcessManagerModalProps) {
  const [runners, setRunners] = useState<RunnerProcess[]>([]);
  const [filter, setFilter] = useState<"running" | "all">("running");

  const fetchRunners = useCallback(() => {
    fetch("/api/runners")
      .then((r) => r.json())
      .then((d: { processes: RunnerProcess[] }) => setRunners(d.processes ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    fetchRunners();
    const t = setInterval(fetchRunners, 2000);
    return () => clearInterval(t);
  }, [open, fetchRunners]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sessionName = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  const visible = runners.filter((p) =>
    filter === "running" ? p.exitCode === null : true
  );
  const runningCount = runners.filter((p) => p.exitCode === null).length;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[760px] max-h-[80vh] flex flex-col border border-c-border rounded-xl shadow-2xl overflow-hidden"
        style={{ backgroundColor: "#1a1a24" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-c-border-subtle flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-c-text">Process Manager</h2>
            <span className="text-2xs text-c-muted">
              {runningCount} running{runners.length !== runningCount ? ` · ${runners.length} total` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex border border-c-border-subtle rounded overflow-hidden">
              <button
                onClick={() => setFilter("running")}
                className={`px-2 py-0.5 text-2xs ${
                  filter === "running"
                    ? "bg-c-surface-active text-c-text"
                    : "text-c-muted hover:text-c-text-secondary"
                }`}
              >
                Running
              </button>
              <button
                onClick={() => setFilter("all")}
                className={`px-2 py-0.5 text-2xs ${
                  filter === "all"
                    ? "bg-c-surface-active text-c-text"
                    : "text-c-muted hover:text-c-text-secondary"
                }`}
              >
                All
              </button>
            </div>
            <button
              onClick={onClose}
              className="text-c-muted hover:text-c-text p-1"
              title="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <p className="text-xs text-c-muted">
                {filter === "running" ? "No running processes" : "No processes"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-c-border-subtle">
              {visible.map((proc) => (
                <ProcessRow
                  key={proc.id}
                  proc={proc}
                  sessionName={sessionName(proc.sessionId)}
                  onKill={() => onKillRunner(proc.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProcessRow({
  proc,
  sessionName,
  onKill,
}: {
  proc: RunnerProcess;
  sessionName: string;
  onKill: () => void;
}) {
  const isRunning = proc.exitCode === null;
  return (
    <div className="px-5 py-2.5 hover:bg-c-surface/30 group">
      <div className="flex items-center gap-2 text-2xs">
        {isRunning ? (
          <span className="w-1.5 h-1.5 rounded-full bg-c-success animate-pulse-subtle flex-shrink-0" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-c-muted flex-shrink-0" />
        )}
        <span className="text-c-muted w-24 truncate flex-shrink-0" title={sessionName}>
          {sessionName}
        </span>
        <span className="font-mono tabular-nums text-c-muted w-12 flex-shrink-0">
          {proc.pid || "—"}
        </span>
        <span className="flex-1 min-w-0 truncate text-c-text-secondary" title={proc.description || proc.command}>
          {proc.description ? (
            <>
              {proc.description}{" "}
              <span className="text-c-muted/70 font-mono">— {proc.command}</span>
            </>
          ) : (
            <span className="font-mono">{proc.command}</span>
          )}
        </span>

        {/* Slot ports */}
        {proc.slots.length > 0 && (
          <span className="font-mono tabular-nums flex-shrink-0 flex items-center gap-1">
            {proc.slots.map((slot) => (
              <a
                key={slot.name}
                href={`http://localhost:${slot.port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-c-accent hover:text-c-accent-hover hover:underline"
                title={`${slot.name === "PORT" ? "PORT" : `${slot.name}_PORT`}=${slot.port}`}
              >
                {slot.name === "PORT" ? `:${slot.port}` : `${slot.name.toLowerCase()}:${slot.port}`}
              </a>
            ))}
          </span>
        )}

        {/* Exit code */}
        {!isRunning && (
          <span
            className={`font-mono tabular-nums flex-shrink-0 ${
              proc.exitCode === 0 ? "text-c-muted" : "text-c-error"
            }`}
          >
            exit {proc.exitCode}
          </span>
        )}

        {/* Kill */}
        {isRunning && (
          <button
            onClick={onKill}
            className="opacity-0 group-hover:opacity-100 text-c-error hover:text-c-error/80 transition-opacity flex-shrink-0 px-1.5 py-0.5 border border-c-error/30 rounded text-2xs"
            title="Kill process"
          >
            kill
          </button>
        )}
      </div>
    </div>
  );
}
