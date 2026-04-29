import { useState, useEffect, useRef, useCallback } from "react";
import { DirTypeahead } from "./DirTypeahead";
import { useSettings } from "../lib/settings";

interface NewSessionModalProps {
  open: boolean;
  projectRoot: string;
  sessionCount: number;
  onClose: () => void;
  onCreate: (opts: { name: string; cwd?: string; useWorktree: boolean }) => void;
}

export function NewSessionModal({
  open,
  projectRoot,
  sessionCount,
  onClose,
  onCreate,
}: NewSessionModalProps) {
  const settings = useSettings();
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(projectRoot);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [checkingGit, setCheckingGit] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setName(`Session ${sessionCount + 1}`);
      const defaultCwd = settings.defaultSessionFolder || projectRoot;
      setCwd(defaultCwd);
      setUseWorktree(true);
      checkGitRepo(defaultCwd);
      setTimeout(() => nameRef.current?.select(), 50);
    }
  }, [open, projectRoot, sessionCount, settings.defaultSessionFolder]);

  const checkGitRepo = useCallback((path: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const trimmed = path.trim().replace(/\/+$/, "");
      if (!trimmed) {
        setIsGitRepo(false);
        return;
      }
      setCheckingGit(true);
      try {
        const res = await fetch(
          `/api/git/check?path=${encodeURIComponent(trimmed)}`
        );
        const data = await res.json();
        setIsGitRepo(data.isGitRepo);
        if (!data.isGitRepo) setUseWorktree(false);
        else setUseWorktree(true);
      } catch {
        setIsGitRepo(false);
      } finally {
        setCheckingGit(false);
      }
    }, 200);
  }, []);

  const handleCwdChange = (v: string) => {
    setCwd(v);
    checkGitRepo(v);
  };

  const handleSubmit = () => {
    const trimmedCwd = cwd.trim() || projectRoot;
    onCreate({
      name: name.trim() || `Session ${sessionCount + 1}`,
      cwd: trimmedCwd !== projectRoot ? trimmedCwd : undefined,
      useWorktree: isGitRepo && useWorktree,
    });
    onClose();
  };

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
    >
      <div className="w-[440px] border border-c-border rounded-xl shadow-2xl overflow-hidden animate-slide-up" style={{ backgroundColor: "#1a1a24" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-c-border">
          <h2 className="text-sm font-semibold text-c-text">New Session</h2>
          <button
            onClick={onClose}
            className="text-c-muted hover:text-c-text w-6 h-6 flex items-center justify-center rounded-md hover:bg-c-surface-active"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-c-text block mb-1.5">
              Name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              className="w-full text-xs font-mono bg-c-surface border border-c-border rounded-md px-2.5 py-1.5 text-c-text outline-none focus:border-c-accent/50"
            />
          </div>

          {/* Directory */}
          <div>
            <label className="text-xs font-medium text-c-text block mb-1.5">
              Working directory
            </label>
            <DirTypeahead
              value={cwd}
              onChange={handleCwdChange}
              onSubmit={handleSubmit}
              onCancel={onClose}
            />
          </div>

          {/* Worktree toggle */}
          {isGitRepo && (
            <div className="flex items-center justify-between py-2 px-3 bg-c-surface rounded-md border border-c-border">
              <div>
                <p className="text-xs font-medium text-c-text">
                  Use git worktree
                </p>
                <p className="text-2xs text-c-muted mt-0.5">
                  Isolate changes in a separate working tree
                </p>
              </div>
              <button
                onClick={() => setUseWorktree((v) => !v)}
                className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
                  useWorktree ? "bg-c-accent" : "bg-c-surface-active"
                }`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                    useWorktree ? "left-[16px]" : "left-[2px]"
                  }`}
                />
              </button>
            </div>
          )}

          {checkingGit && (
            <p className="text-2xs text-c-muted flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-c-accent animate-pulse-subtle" />
              Checking git status...
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-c-border flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-c-muted hover:text-c-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-1.5 text-xs font-medium bg-c-accent hover:bg-c-accent-hover text-white rounded-md transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
