import { useEffect, useState } from "react";
import { useRunnerState } from "../lib/store";

interface SessionDetails {
  cwd: string;
  isGitRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  modifiedCount: number;
  untrackedCount: number;
  stagedCount: number;
  remoteUrl?: string;
  githubUrl?: string;
  headSha?: string;
  headSubject?: string;
}

interface DetailsPanelProps {
  sessionId: string;
}

export function DetailsPanel({ sessionId }: DetailsPanelProps) {
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const runnerState = useRunnerState(sessionId);

  useEffect(() => {
    if (!sessionId) return;
    const fetchDetails = () => {
      fetch(`/api/sessions/${sessionId}/details`)
        .then((r) => r.json())
        .then((d: SessionDetails) => setDetails(d))
        .catch(() => {});
    };
    fetchDetails();
    const t = setInterval(fetchDetails, 5000);
    return () => clearInterval(t);
  }, [sessionId]);

  const runners = runnerState.processes;
  const runningRunners = runners.filter((p) => p.exitCode === null);

  return (
    <div className="h-full overflow-y-auto bg-c-bg">
      <div className="px-4 py-3 space-y-4">
        {/* Path */}
        <Section label="Path">
          <div className="flex items-center gap-1.5">
            <code className="text-2xs font-mono text-c-text-secondary break-all flex-1">
              {details?.cwd ?? "—"}
            </code>
            {details?.cwd && (
              <CopyButton value={details.cwd} title="Copy path" />
            )}
          </div>
        </Section>

        {/* Repo */}
        {(details?.remoteUrl || details?.githubUrl) && (
          <Section label="Repo">
            <div className="space-y-1.5 text-2xs">
              {details.githubUrl && (
                <Row k="github">
                  <a
                    href={details.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-c-accent hover:text-c-accent-hover hover:underline break-all"
                  >
                    {details.githubUrl}
                  </a>
                </Row>
              )}
              {details.remoteUrl && details.remoteUrl !== details.githubUrl && (
                <Row k="origin">
                  <code className="font-mono text-c-muted break-all">
                    {details.remoteUrl}
                  </code>
                </Row>
              )}
            </div>
          </Section>
        )}

        {/* Git */}
        {details?.isGitRepo && (
          <Section label="Git">
            <div className="space-y-1.5 text-2xs">
              {details.branch && (
                <Row k="branch">
                  {details.githubUrl ? (
                    <a
                      href={`${details.githubUrl}/tree/${encodeURI(details.branch)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-c-accent hover:text-c-accent-hover hover:underline"
                    >
                      {details.branch}
                    </a>
                  ) : (
                    <span className="font-mono text-c-text-secondary">
                      {details.branch}
                    </span>
                  )}
                  {(details.ahead ?? 0) > 0 || (details.behind ?? 0) > 0 ? (
                    <span className="ml-2 text-c-muted font-mono tabular-nums">
                      {details.ahead ? `↑${details.ahead}` : ""}
                      {details.ahead && details.behind ? " " : ""}
                      {details.behind ? `↓${details.behind}` : ""}
                    </span>
                  ) : null}
                </Row>
              )}
              <Row k="status">
                <StatusCounts
                  modified={details.modifiedCount}
                  untracked={details.untrackedCount}
                  staged={details.stagedCount}
                />
              </Row>
              {details.headSha && (
                <Row k="HEAD">
                  <span className="font-mono text-c-muted">{details.headSha}</span>
                  {details.headSubject && (
                    <span className="ml-2 text-c-text-secondary truncate">
                      {details.headSubject}
                    </span>
                  )}
                </Row>
              )}
            </div>
          </Section>
        )}

        {/* Processes */}
        <Section label={`Processes (${runningRunners.length} running)`}>
          {runners.length === 0 ? (
            <p className="text-2xs text-c-muted">None</p>
          ) : (
            <div className="space-y-1">
              {runners.slice(0, 10).map((proc) => {
                const isRunning = proc.exitCode === null;
                return (
                  <div key={proc.id} className="flex items-center gap-2 text-2xs">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        isRunning
                          ? "bg-c-success animate-pulse-subtle"
                          : "bg-c-muted"
                      }`}
                    />
                    <span className="text-c-text-secondary truncate flex-1 min-w-0" title={proc.description || proc.command}>
                      {proc.description ? (
                        <>
                          {proc.description}{" "}
                          <span className="text-c-muted/70 font-mono">— {proc.command}</span>
                        </>
                      ) : (
                        <span className="font-mono">{proc.command}</span>
                      )}
                    </span>
                    {proc.slots.length > 0 && (
                      <span className="font-mono tabular-nums text-c-accent flex-shrink-0">
                        {proc.slots.map((s) => `:${s.port}`).join(" ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xs text-c-muted mb-1.5 uppercase tracking-wider">{label}</p>
      {children}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-c-muted w-14 flex-shrink-0">{k}</span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
    </div>
  );
}

function StatusCounts({
  modified,
  untracked,
  staged,
}: {
  modified: number;
  untracked: number;
  staged: number;
}) {
  if (modified === 0 && untracked === 0 && staged === 0) {
    return <span className="text-c-muted">clean</span>;
  }
  const parts: { label: string; count: number; color: string }[] = [];
  if (staged > 0) parts.push({ label: "staged", count: staged, color: "text-c-success" });
  if (modified > 0) parts.push({ label: "modified", count: modified, color: "text-c-accent" });
  if (untracked > 0) parts.push({ label: "untracked", count: untracked, color: "text-c-muted" });
  return (
    <span className="flex items-center gap-2 font-mono tabular-nums text-2xs">
      {parts.map((p) => (
        <span key={p.label} className={p.color}>
          {p.count} {p.label}
        </span>
      ))}
    </span>
  );
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="flex-shrink-0 text-c-muted hover:text-c-text-secondary p-0.5"
      title={title}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
