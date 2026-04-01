import { useState } from "react";
import type { SubagentInfo, StreamEvent } from "../lib/types";

interface SubagentPanelProps {
  subagents: Map<string, SubagentInfo>;
}

export function SubagentPanel({ subagents }: SubagentPanelProps) {
  if (subagents.size === 0) return null;

  const entries = Array.from(subagents.entries());
  const activeCount = entries.filter(([, i]) => i.status === "active").length;

  return (
    <div className="border-t border-c-border bg-c-bg-raised">
      <div className="h-6 flex items-center px-3 border-b border-c-border-subtle">
        <span className="text-2xs font-medium text-c-text-secondary uppercase tracking-wider">Subagents</span>
        {activeCount > 0 && (
          <span className="ml-1.5 px-1 py-px bg-c-accent-subtle text-c-accent text-2xs rounded-full font-medium">
            {activeCount}
          </span>
        )}
      </div>
      <div className="max-h-40 overflow-y-auto">
        {entries.map(([id, info]) => <SubagentCard key={id} info={info} />)}
      </div>
    </div>
  );
}

function SubagentCard({ info }: { info: SubagentInfo }) {
  const [expanded, setExpanded] = useState(false);
  const lastEvent = info.events[info.events.length - 1];
  const lastText = getPreview(lastEvent);

  return (
    <div className="border-b border-c-border-subtle last:border-b-0">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-c-surface-hover text-left transition-colors">
        <span className={`w-1 h-1 rounded-full flex-shrink-0 ${info.status === "active" ? "bg-c-success animate-pulse-subtle" : "bg-c-muted/40"}`} />
        <span className="text-2xs font-mono font-medium text-c-accent flex-shrink-0">{info.agentType ?? "Agent"}</span>
        <span className="text-2xs text-c-muted truncate flex-1">{lastText}</span>
        <span className="text-2xs text-c-muted tabular-nums">{info.events.length}</span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-c-muted transition-transform ${expanded ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-0.5 space-y-0.5 max-h-36 overflow-y-auto">
          {info.events.map((event, i) => <SubagentEvent key={i} event={event} />)}
        </div>
      )}
    </div>
  );
}

function SubagentEvent({ event }: { event: StreamEvent }) {
  if (event.type === "message") {
    return <div className="text-2xs text-c-text-secondary whitespace-pre-wrap">{(event.data as { text: string }).text}</div>;
  }
  if (event.type === "tool_use") {
    const d = event.data as { name: string; input: unknown };
    return <div className="text-2xs text-c-muted font-mono">{d.name}({trunc(d.input)})</div>;
  }
  return null;
}

function getPreview(e: StreamEvent | undefined): string {
  if (!e) return "";
  if (e.type === "message") return (e.data as { text: string }).text.slice(0, 60).replace(/\n/g, " ");
  if (e.type === "tool_use") return `${(e.data as { name: string }).name}...`;
  return e.type;
}

function trunc(obj: unknown): string {
  const s = JSON.stringify(obj);
  return s.length > 40 ? s.slice(0, 40) + "..." : s;
}
