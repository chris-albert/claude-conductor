import { useState, useRef, useEffect, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessionState, useSessionPorts } from "../lib/store";
import { SubagentPanel } from "./SubagentPanel";
import { ProcessPanel } from "./ProcessPanel";
import type { StreamEvent, UsageData, SessionInfo, PortInfo } from "../lib/types";

const MODELS = [
  { id: "", label: "Default" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

const PERMISSION_MODES = [
  { id: "bypassPermissions", label: "Bypass" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "default", label: "Default (ask)" },
  { id: "plan", label: "Plan only" },
];

interface SessionPaneProps {
  sessionId: string;
  onSendPrompt: (sessionId: string, prompt: string, model?: string, permissionMode?: string) => void;
  onKillProcess: (pid: number) => void;
  onRunCommand: (command: string) => void;
  onKillRunner: (runnerId: string) => void;
  isStreaming: boolean;
}

export function SessionPane({
  sessionId,
  onSendPrompt,
  onKillProcess,
  onRunCommand,
  onKillRunner,
  isStreaming,
}: SessionPaneProps) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("bypassPermissions");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { events, subagents, info, usage, lastCost, contextWindow } =
    useSessionState(sessionId);
  const ports = useSessionPorts(sessionId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isStreaming) return;
    onSendPrompt(sessionId, prompt.trim(), model || undefined, permissionMode);
    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col h-full bg-c-bg">
      {/* Status bar */}
      <StatusBar
        info={info}
        usage={usage}
        cost={lastCost}
        contextWindow={contextWindow}
        isStreaming={isStreaming}
        ports={ports}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-3 py-3 space-y-0.5">
          {events.length === 0 && !isStreaming && (
            <div className="flex items-center justify-center py-16">
              <p className="text-c-muted text-xs">Send a message to begin.</p>
            </div>
          )}
          {events.map((event, i) => {
            // Skip tool_results that were already consumed by a paired Bash block
            if (event.type === "tool_result" && i > 0) {
              const prev = events[i - 1];
              if (prev.type === "tool_use" && (prev.data as { name: string }).name === "Bash") {
                return null;
              }
            }
            // Pair Bash tool_use with its following tool_result
            if (event.type === "tool_use" && (event.data as { name: string }).name === "Bash") {
              const result = i + 1 < events.length && events[i + 1].type === "tool_result" ? events[i + 1] : null;
              return <BashBlock key={i} event={event} result={result} />;
            }
            return <EventBlock key={i} event={event} onRunCommand={onRunCommand} />;
          })}
          {isStreaming &&
            events.length > 0 &&
            events[events.length - 1].type !== "user_message" && (
              <div className="flex items-center gap-1.5 py-1.5 px-1">
                <span
                  className="w-1 h-1 rounded-full bg-c-muted animate-pulse-subtle"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-c-muted animate-pulse-subtle"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-c-muted animate-pulse-subtle"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
            )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Subagents */}
      <SubagentPanel subagents={subagents} />

      {/* Process manager */}
      <ProcessPanel sessionId={sessionId} onKillProcess={onKillProcess} onRunCommand={onRunCommand} onKillRunner={onKillRunner} />

      {/* Input */}
      <div className="border-t border-c-border">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto px-3 py-2">
          <div className="relative bg-c-surface border border-c-border rounded-lg focus-within:border-c-accent/50 transition-colors">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Claude... (Markdown supported)"
              disabled={isStreaming}
              rows={4}
              className="w-full bg-transparent border-0 resize-y px-3 py-2 text-[13px] text-c-text font-mono placeholder:text-c-muted placeholder:font-sans focus:outline-none disabled:opacity-40 min-h-[60px] max-h-[300px]"
            />
            <div className="flex items-center gap-2 px-3 pb-1.5">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isStreaming}
                className="bg-c-bg-raised border border-c-border-subtle rounded px-1.5 py-0.5 text-2xs text-c-text-secondary focus:outline-none focus:border-c-accent/50 disabled:opacity-40"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
                disabled={isStreaming}
                className="bg-c-bg-raised border border-c-border-subtle rounded px-1.5 py-0.5 text-2xs text-c-text-secondary focus:outline-none focus:border-c-accent/50 disabled:opacity-40"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <span className="text-2xs text-c-muted ml-auto">
                Enter send, Shift+Enter newline
              </span>
              <button
                type="submit"
                disabled={isStreaming || !prompt.trim()}
                className="w-7 h-7 flex items-center justify-center rounded-md bg-c-accent hover:bg-c-accent-hover text-white disabled:opacity-30 disabled:hover:bg-c-accent transition-colors flex-shrink-0"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function StatusBar({
  info,
  usage,
  cost,
  contextWindow,
  isStreaming,
  ports,
}: {
  info: SessionInfo | null;
  usage: UsageData | null;
  cost: number | null;
  contextWindow: number | null;
  isStreaming: boolean;
  ports: PortInfo[];
}) {
  const ctxPct =
    usage && contextWindow
      ? Math.min(100, (usage.totalTokens / contextWindow) * 100)
      : 0;

  return (
    <div className="h-7 flex items-center px-3 border-b border-c-border text-2xs text-c-muted gap-4 flex-shrink-0">
      {/* Streaming indicator */}
      {isStreaming && (
        <span className="flex items-center gap-1 text-c-success">
          <span className="w-1 h-1 rounded-full bg-c-success animate-pulse-subtle" />
          streaming
        </span>
      )}

      {/* Model */}
      {info?.model && (
        <span className="font-mono">{info.model.replace("claude-", "").split("-202")[0]}</span>
      )}

      {/* Active ports */}
      {ports.length > 0 && (
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-c-success">
            <circle cx="12" cy="12" r="2" />
            <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
            <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
          </svg>
          {ports.map((p) => (
            <a
              key={p.port}
              href={`http://localhost:${p.port}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-c-accent hover:text-c-accent-hover hover:underline tabular-nums"
              title={`${p.process || "unknown"} (PID ${p.pid || "?"})\nDetected: ${p.detectedFrom}`}
            >
              :{p.port}
            </a>
          ))}
        </span>
      )}

      {/* Context usage bar */}
      {usage && (
        <span className="flex items-center gap-1.5">
          <span className="text-c-muted/60">ctx</span>
          <span className="w-16 h-1.5 bg-c-surface rounded-full overflow-hidden">
            <span
              className={`block h-full rounded-full transition-all ${
                ctxPct > 80 ? "bg-c-warning" : ctxPct > 50 ? "bg-c-accent" : "bg-c-success"
              }`}
              style={{ width: `${ctxPct}%` }}
            />
          </span>
          <span className="tabular-nums">
            {fmtTokens(usage.totalTokens)}
            {contextWindow ? ` / ${fmtTokens(contextWindow)}` : ""}
          </span>
        </span>
      )}

      {/* Token breakdown */}
      {usage && (
        <span className="flex items-center gap-2 tabular-nums">
          <span>
            <span className="text-c-muted/50">in </span>
            {fmtTokens(usage.inputTokens)}
          </span>
          <span>
            <span className="text-c-muted/50">out </span>
            {fmtTokens(usage.outputTokens)}
          </span>
          {usage.cacheRead > 0 && (
            <span>
              <span className="text-c-muted/50">cache </span>
              {fmtTokens(usage.cacheRead)}
            </span>
          )}
        </span>
      )}

      {/* Cost */}
      {cost != null && (
        <span className="ml-auto tabular-nums">
          ${cost.toFixed(4)}
        </span>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Detect if inline code looks like a runnable command */
const CMD_PATTERN = /^(npm|pnpm|yarn|bun|npx|node|python|pip|cargo|go|ruby|php|make|docker|tsx|ts-node)\s/;

function BashBlock({ event, result }: { event: StreamEvent; result: StreamEvent | null }) {
  const data = event.data as { input: { command?: string } };
  const command = data.input?.command ?? "";
  const output = result
    ? typeof result.data === "string"
      ? result.data
      : (result.data as { content?: string })?.content ??
        JSON.stringify(result.data)
    : null;

  return (
    <div className="py-0.5 animate-fade-in">
      <details className="group">
        <summary className="flex items-center gap-1.5 cursor-pointer select-none text-2xs text-c-text-secondary hover:text-c-text transition-colors">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-c-accent flex-shrink-0">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span className="font-mono font-medium truncate">{command}</span>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90 flex-shrink-0">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </summary>
        {output && (
          <div className="mt-1 ml-4 p-2 bg-c-surface rounded border border-c-border-subtle">
            <pre className="text-2xs text-c-text-secondary font-mono overflow-x-auto max-h-48 whitespace-pre-wrap leading-relaxed">
              {output}
            </pre>
          </div>
        )}
      </details>
    </div>
  );
}

function EventBlock({ event, onRunCommand }: { event: StreamEvent; onRunCommand?: (cmd: string) => void }) {
  if (event.type === "user_message") {
    const data = event.data as { text: string };
    return (
      <div className="flex justify-end py-1 animate-fade-in">
        <div className="max-w-[85%] bg-c-user border border-c-user-border rounded-lg rounded-br-sm px-3 py-1.5">
          <p className="text-[13px] whitespace-pre-wrap leading-relaxed text-c-text">
            {data.text}
          </p>
        </div>
      </div>
    );
  }

  if (event.type === "message") {
    const data = event.data as { text: string };
    return (
      <div className="py-1 animate-fade-in prose-container">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const isInline = !className;
              const text = String(children).replace(/\n$/, "");

              if (isInline) {
                const isRunnable = onRunCommand && CMD_PATTERN.test(text);
                return (
                  <span className={isRunnable ? "inline-flex items-center gap-1" : ""}>
                    <code className="bg-c-surface px-1 py-0.5 rounded text-[12px] font-mono text-c-accent" {...props}>
                      {children}
                    </code>
                    {isRunnable && (
                      <button
                        onClick={() => onRunCommand(text)}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-c-accent/15 hover:bg-c-accent/25 text-c-accent rounded transition-colors"
                        title={`Run "${text}" in the process panel`}
                      >
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        Run
                      </button>
                    )}
                  </span>
                );
              }

              // Code blocks: check if it's a single-line command
              const isRunnableBlock = onRunCommand && text.split("\n").length === 1 && CMD_PATTERN.test(text);
              return (
                <div className="relative group/codeblock">
                  <pre className="bg-c-surface border border-c-border-subtle rounded-md p-3 overflow-x-auto my-1.5">
                    <code className="text-[12px] font-mono text-c-text-secondary leading-relaxed" {...props}>
                      {children}
                    </code>
                  </pre>
                  {isRunnableBlock && (
                    <button
                      onClick={() => onRunCommand(text)}
                      className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-c-accent hover:bg-c-accent-hover text-white rounded opacity-0 group-hover/codeblock:opacity-100 transition-opacity"
                      title={`Run "${text}" in the process panel`}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      Run
                    </button>
                  )}
                </div>
              );
            },
          }}
        >
          {data.text}
        </ReactMarkdown>
      </div>
    );
  }

  if (event.type === "tool_use") {
    const data = event.data as { name: string; id: string; input: unknown };
    return (
      <div className="py-0.5 animate-fade-in">
        <details className="group">
          <summary className="flex items-center gap-1.5 cursor-pointer select-none text-2xs text-c-text-secondary hover:text-c-text transition-colors">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-c-accent flex-shrink-0">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span className="font-mono font-medium">{data.name}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </summary>
          <div className="mt-1 ml-4 p-2 bg-c-surface rounded border border-c-border-subtle">
            <pre className="text-2xs text-c-text-secondary font-mono overflow-x-auto max-h-32 leading-relaxed">
              {JSON.stringify(data.input, null, 2)}
            </pre>
          </div>
        </details>
      </div>
    );
  }

  if (event.type === "tool_result") {
    return (
      <div className="py-0.5 animate-fade-in">
        <details className="group">
          <summary className="flex items-center gap-1.5 cursor-pointer select-none text-2xs text-c-muted hover:text-c-text-secondary transition-colors">
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
            <span>Result</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90"><polyline points="9 18 15 12 9 6" /></svg>
          </summary>
          <div className="mt-1 ml-4 p-2 bg-c-surface rounded border border-c-border-subtle">
            <pre className="text-2xs text-c-muted font-mono overflow-x-auto max-h-32 leading-relaxed">
              {typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2)}
            </pre>
          </div>
        </details>
      </div>
    );
  }

  if (event.type === "auth_status") {
    const data = event.data as { isAuthenticating: boolean; output: string[]; error?: string };
    return (
      <div className="py-1 animate-fade-in">
        <div className={`p-3 rounded border ${data.error ? "bg-c-error-subtle border-c-error/20" : "bg-c-accent/10 border-c-accent/20"}`}>
          <div className="flex items-start gap-2">
            {data.isAuthenticating ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-c-accent mt-0.5 flex-shrink-0 animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-c-accent mt-0.5 flex-shrink-0">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-c-text mb-1.5">
                {data.isAuthenticating ? "Authentication required" : data.error ? "Authentication failed" : "Authenticated"}
              </p>
              {data.output.map((line, i) => {
                const urlMatch = line.match(/(https?:\/\/\S+)/);
                if (urlMatch) {
                  const url = urlMatch[1];
                  const before = line.slice(0, urlMatch.index);
                  const after = line.slice((urlMatch.index ?? 0) + url.length);
                  return (
                    <p key={i} className="text-[13px] text-c-text-secondary font-mono break-all leading-relaxed">
                      {before}
                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-c-accent underline hover:text-c-accent-hover">{url}</a>
                      {after}
                    </p>
                  );
                }
                return <p key={i} className="text-[13px] text-c-text-secondary font-mono whitespace-pre-wrap leading-relaxed">{line}</p>;
              })}
              {data.error && (
                <p className="text-[13px] text-c-error font-mono mt-1">{data.error}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (event.type === "error") {
    const data = event.data as { message: string; stack?: string; cwd?: string };
    return (
      <div className="py-1 animate-fade-in">
        <div className="p-2 bg-c-error-subtle rounded border border-c-error/20">
          <div className="flex items-start gap-1.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-c-error mt-px flex-shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <pre className="text-[13px] text-c-error whitespace-pre-wrap font-mono break-all">{data.message}</pre>
          </div>
          {data.cwd && (
            <p className="text-2xs text-c-error/60 mt-1 ml-4 font-mono">cwd: {data.cwd}</p>
          )}
          {data.stack && (
            <details className="mt-1.5 ml-4">
              <summary className="text-2xs text-c-error/50 cursor-pointer hover:text-c-error/70">Stack trace</summary>
              <pre className="text-2xs text-c-error/40 font-mono mt-1 overflow-x-auto max-h-40 whitespace-pre-wrap">{data.stack}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }

  if (event.type === "session_complete") {
    const data = event.data as { cost?: number; duration?: number; turns?: number } | null;
    return (
      <div className="py-2 animate-fade-in">
        <div className="flex items-center gap-2 text-2xs text-c-muted">
          <div className="flex-1 h-px bg-c-border" />
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
          <span>
            Done
            {data?.cost != null && ` | $${data.cost.toFixed(4)}`}
            {data?.duration != null && ` | ${(data.duration / 1000).toFixed(1)}s`}
            {data?.turns != null && ` | ${data.turns}t`}
          </span>
          <div className="flex-1 h-px bg-c-border" />
        </div>
      </div>
    );
  }

  return null;
}
