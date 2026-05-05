import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionPorts } from "../lib/store";
import type { PortInfo } from "../lib/types";

interface BrowserPanelProps {
  sessionId: string;
}

export function BrowserPanel({ sessionId }: BrowserPanelProps) {
  const ports = useSessionPorts(sessionId);
  const [url, setUrl] = useState("");
  const [loadedUrl, setLoadedUrl] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-navigate to the first port if no URL is set yet
  const effectiveUrl = loadedUrl || (ports.length > 0 ? `http://localhost:${ports[0].port}` : "");

  const navigate = useCallback((target: string) => {
    const normalized = target.match(/^https?:\/\//) ? target : `http://${target}`;
    setLoadedUrl(normalized);
    setUrl(normalized);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) navigate(url.trim());
  };

  const handlePortClick = (port: number) => {
    navigate(`http://localhost:${port}`);
  };

  const reload = () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  };

  // Auto-load when first port appears
  useEffect(() => {
    if (!loadedUrl && ports.length > 0) {
      navigate(`http://localhost:${ports[0].port}`);
    }
  }, [loadedUrl, ports, navigate]);

  return (
    <div className="flex flex-col h-full bg-c-bg">
      {/* URL bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-c-border-subtle flex-shrink-0">
        {/* Reload */}
        <button
          onClick={reload}
          className="text-c-muted hover:text-c-text-secondary p-0.5 rounded transition-colors flex-shrink-0"
          title="Reload"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>

        {/* URL input */}
        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            ref={inputRef}
            value={url || effectiveUrl}
            onChange={(e) => setUrl(e.target.value)}
            onFocus={() => inputRef.current?.select()}
            placeholder="http://localhost:3000"
            className="w-full text-2xs font-mono bg-c-surface border border-c-border-subtle rounded px-2 py-0.5 text-c-text outline-none focus:border-c-accent/40 placeholder:text-c-muted/40"
          />
        </form>

        {/* Open in new tab */}
        {effectiveUrl && (
          <a
            href={effectiveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-c-muted hover:text-c-text-secondary p-0.5 rounded transition-colors flex-shrink-0"
            title="Open in new tab"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        )}
      </div>

      {/* Port quick-nav */}
      {ports.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-c-border-subtle flex-shrink-0">
          <span className="text-2xs text-c-muted">Ports:</span>
          {ports.map((p) => (
            <PortButton
              key={p.port}
              port={p}
              isActive={effectiveUrl === `http://localhost:${p.port}`}
              onClick={() => handlePortClick(p.port)}
            />
          ))}
        </div>
      )}

      {/* iframe */}
      <div className="flex-1 min-h-0">
        {effectiveUrl ? (
          <iframe
            ref={iframeRef}
            src={effectiveUrl}
            className="w-full h-full border-0"
            title="Browser preview"
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 text-c-muted">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <p className="text-xs text-c-muted">No server running</p>
              <p className="text-2xs text-c-muted/60 mt-1">Start a dev server in the Processes tab or enter a URL above</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PortButton({ port, isActive, onClick }: { port: PortInfo; isActive: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-1.5 py-0.5 text-2xs font-mono rounded transition-colors ${
        isActive
          ? "bg-c-accent/15 text-c-accent border border-c-accent/30"
          : "text-c-muted hover:text-c-text-secondary border border-c-border-subtle"
      }`}
      title={`${port.process} (PID ${port.pid})`}
    >
      :{port.port}
    </button>
  );
}
