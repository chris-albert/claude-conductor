import { useState, useRef, useEffect } from "react";
import { useSessionProcesses, useRunnerState } from "../lib/store";
import type { SessionProcessState, TrackedCommand, RunnerProcess } from "../lib/types";

interface ProcessPanelProps {
  sessionId: string;
  onKillProcess: (pid: number) => void;
  onRunCommand: (command: string) => void;
  onKillRunner: (runnerId: string) => void;
}

export function ProcessPanel({ sessionId, onKillProcess, onRunCommand, onKillRunner }: ProcessPanelProps) {
  const processState = useSessionProcesses(sessionId);
  const runnerState = useRunnerState(sessionId);
  const [cmdInput, setCmdInput] = useState("");

  const hasProcesses = processState.processes.length > 0;
  const hasRunners = runnerState.processes.length > 0;
  const hasCommands = processState.commands.length > 0;
  const runningRunners = runnerState.processes.filter((p) => p.exitCode === null);
  const totalRunning = processState.processes.length + runningRunners.length;

  const handleRunSubmit = () => {
    const cmd = cmdInput.trim();
    if (!cmd) return;
    onRunCommand(cmd);
    setCmdInput("");
  };

  return (
    <div className="flex flex-col h-full bg-c-bg">
      {/* Summary bar */}
      <div className="h-6 flex items-center px-3 border-b border-c-border-subtle flex-shrink-0 gap-3">
        {totalRunning > 0 && (
          <span className="text-2xs text-c-success flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-c-success animate-pulse-subtle" />
            {totalRunning} running
          </span>
        )}
        {(hasRunners || hasProcesses) && (
          <span className="ml-auto flex items-center gap-1.5 font-mono tabular-nums text-2xs">
            {[
              ...runnerState.processes.filter((p) => p.exitCode === null).flatMap((p) => p.ports),
              ...processState.processes.flatMap((p) => p.ports),
            ].map((port) => (
              <a
                key={port}
                href={`http://localhost:${port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-c-accent hover:text-c-accent-hover hover:underline"
              >
                :{port}
              </a>
            ))}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {/* Command input */}
        <div className="flex items-center gap-1.5">
          <span className="text-c-muted text-2xs">$</span>
          <input
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRunSubmit(); }}
            placeholder="Run a command..."
            className="flex-1 bg-transparent border border-c-border-subtle rounded px-2 py-1 text-2xs font-mono text-c-text outline-none focus:border-c-accent/40 placeholder:text-c-muted/50"
          />
          <button
            onClick={handleRunSubmit}
            disabled={!cmdInput.trim()}
            className="px-2 py-1 text-2xs font-medium bg-c-accent hover:bg-c-accent-hover disabled:opacity-30 text-white rounded transition-colors"
          >
            Run
          </button>
        </div>

        {/* Conductor-owned processes */}
        {hasRunners && (
          <div>
            <p className="text-2xs text-c-muted mb-1.5 uppercase tracking-wider">Conductor</p>
            <div className="space-y-1.5">
              {runnerState.processes.map((proc) => (
                <RunnerProcessRow key={proc.id} proc={proc} onKill={() => onKillRunner(proc.id)} onRerun={() => onRunCommand(proc.command)} />
              ))}
            </div>
          </div>
        )}

        {/* Claude-detected processes */}
        {hasProcesses && (
          <div>
            <p className="text-2xs text-c-muted mb-1.5 uppercase tracking-wider">Claude</p>
            <div className="space-y-px">
              {processState.processes.map((proc) => (
                <ProcessRow key={proc.pid} proc={proc} onKill={() => onKillProcess(proc.pid)} />
              ))}
            </div>
          </div>
        )}

        {/* Recent commands */}
        {hasCommands && (
          <div>
            <p className="text-2xs text-c-muted mb-1.5 uppercase tracking-wider">Recent commands</p>
            <div className="space-y-px">
              {processState.commands.slice(-25).reverse().map((cmd) => (
                <CommandRow key={cmd.toolUseId} cmd={cmd} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!hasRunners && !hasProcesses && !hasCommands && (
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 text-c-muted">
                <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <p className="text-xs text-c-muted">No processes yet</p>
              <p className="text-2xs text-c-muted/60 mt-1">Run a command above or let Claude spawn processes</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RunnerProcessRow({ proc, onKill, onRerun }: { proc: RunnerProcess; onKill: () => void; onRerun: () => void }) {
  const [showOutput, setShowOutput] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const isRunning = proc.exitCode === null;

  // Auto-scroll output to bottom
  useEffect(() => {
    if (showOutput && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [proc.output, showOutput]);

  return (
    <div className="bg-c-surface/30 rounded border border-c-border-subtle overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 text-2xs px-2 py-1 group">
        <button
          onClick={() => setShowOutput((v) => !v)}
          className="flex-shrink-0 text-c-muted hover:text-c-text-secondary"
        >
          <svg
            width="8" height="8" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2"
            className={`transition-transform ${showOutput ? "rotate-90" : ""}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        {/* Status dot */}
        {isRunning ? (
          <span className="w-1.5 h-1.5 rounded-full bg-c-success animate-pulse-subtle flex-shrink-0" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-c-muted flex-shrink-0" />
        )}

        {/* PID */}
        <span className="font-mono tabular-nums text-c-muted w-12 flex-shrink-0">{proc.pid}</span>

        {/* Command */}
        <span className="font-mono text-c-text-secondary truncate flex-1 min-w-0" title={proc.command}>
          {proc.command}
        </span>

        {/* Ports */}
        {proc.ports.length > 0 && (
          <span className="font-mono tabular-nums flex-shrink-0">
            {proc.ports.map((port) => (
              <a
                key={port}
                href={`http://localhost:${port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-c-accent hover:text-c-accent-hover hover:underline mr-1"
              >
                :{port}
              </a>
            ))}
          </span>
        )}

        {/* Exit code */}
        {!isRunning && (
          <span className={`font-mono tabular-nums flex-shrink-0 ${proc.exitCode === 0 ? "text-c-muted" : "text-c-error"}`}>
            exit {proc.exitCode}
          </span>
        )}

        {/* Rerun */}
        {!isRunning && (
          <button
            onClick={onRerun}
            className="opacity-0 group-hover:opacity-100 text-c-accent hover:text-c-accent-hover transition-opacity flex-shrink-0"
            title="Rerun command"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}

        {/* Kill */}
        {isRunning && (
          <button
            onClick={onKill}
            className="opacity-0 group-hover:opacity-100 text-c-error hover:text-c-error/80 transition-opacity flex-shrink-0"
            title="Kill process"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Live output */}
      {showOutput && proc.output && (
        <pre
          ref={outputRef}
          className="text-2xs text-c-text-secondary font-mono px-2 pb-2 overflow-x-auto max-h-48 whitespace-pre-wrap leading-relaxed border-t border-c-border-subtle"
        >
          {proc.output}
        </pre>
      )}
    </div>
  );
}

function ProcessRow({
  proc,
  onKill,
}: {
  proc: SessionProcessState["processes"][number];
  onKill: () => void;
}) {
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = !!proc.output;

  return (
    <div>
      <div className="flex items-center gap-2 text-2xs group py-0.5">
        {hasOutput ? (
          <button onClick={() => setShowOutput((v) => !v)} className="flex-shrink-0 text-c-muted hover:text-c-text-secondary">
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`transition-transform ${showOutput ? "rotate-90" : ""}`}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        ) : (
          <span className="w-2 flex-shrink-0" />
        )}
        <span className="w-1.5 h-1.5 rounded-full bg-c-success animate-pulse-subtle flex-shrink-0" />
        <span className="font-mono tabular-nums text-c-muted w-12 flex-shrink-0">{proc.pid}</span>
        <span className="text-c-text-secondary w-14 flex-shrink-0 truncate">{proc.name}</span>
        <span className="font-mono text-c-text-secondary truncate flex-1 min-w-0" title={proc.command}>{proc.command}</span>
        <span className="font-mono tabular-nums flex-shrink-0">
          {proc.ports.map((port) => (
            <a key={port} href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer"
              className="text-c-accent hover:text-c-accent-hover hover:underline mr-1">:{port}</a>
          ))}
        </span>
        <button onClick={onKill}
          className="opacity-0 group-hover:opacity-100 text-c-error hover:text-c-error/80 transition-opacity flex-shrink-0"
          title={`Kill process ${proc.pid}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {showOutput && proc.output && (
        <div className="ml-6 mt-0.5 mb-1.5 bg-c-surface rounded border border-c-border-subtle overflow-hidden">
          <pre className="text-2xs text-c-text-secondary font-mono p-2 overflow-x-auto max-h-48 whitespace-pre-wrap leading-relaxed">{proc.output}</pre>
        </div>
      )}
    </div>
  );
}

function CommandRow({ cmd }: { cmd: TrackedCommand }) {
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = !!cmd.output;

  return (
    <div>
      <div
        onClick={() => hasOutput && setShowOutput((v) => !v)}
        className={`flex items-start gap-2 text-2xs font-mono py-0.5 rounded ${hasOutput ? "cursor-pointer hover:bg-c-surface/30" : ""}`}
      >
        {hasOutput ? (
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`flex-shrink-0 mt-0.5 text-c-muted transition-transform ${showOutput ? "rotate-90" : ""}`}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        ) : (
          <span className="w-2 flex-shrink-0" />
        )}
        <span className="text-c-muted/50 tabular-nums flex-shrink-0">{formatTime(cmd.timestamp)}</span>
        <span className="text-c-text-secondary truncate" title={cmd.command}>{cmd.command}</span>
      </div>
      {showOutput && cmd.output && (
        <div className="ml-4 mt-0.5 mb-1.5 bg-c-surface rounded border border-c-border-subtle overflow-hidden">
          <pre className="text-2xs text-c-text-secondary font-mono p-2 overflow-x-auto max-h-48 whitespace-pre-wrap leading-relaxed">{cmd.output}</pre>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
}
