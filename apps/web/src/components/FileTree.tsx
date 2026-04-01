import { useState, useEffect } from "react";
import type { FileEntry } from "../lib/types";

interface FileTreeProps {
  rootPath: string;
  onSelectFile: (path: string) => void;
  selectedFile: string | null;
}

export function FileTree({ rootPath, onSelectFile, selectedFile }: FileTreeProps) {
  if (!rootPath) return null;

  return (
    <div className="text-xs h-full select-none">
      <div className="py-0.5">
        <DirectoryNode
          path={rootPath}
          name={rootPath.split("/").pop() ?? "root"}
          depth={0}
          onSelectFile={onSelectFile}
          selectedFile={selectedFile}
          defaultOpen
        />
      </div>
    </div>
  );
}

function DirectoryNode({
  path, name, depth, onSelectFile, selectedFile, defaultOpen = false,
}: {
  path: string; name: string; depth: number;
  onSelectFile: (path: string) => void; selectedFile: string | null; defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (isOpen && !loaded) {
      fetch(`/api/files/list?path=${encodeURIComponent(path)}`)
        .then((r) => r.json())
        .then((data) => { setEntries(data); setLoaded(true); })
        .catch(() => setLoaded(true));
    }
  }, [isOpen, loaded, path]);

  return (
    <div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center w-full h-[22px] hover:bg-c-surface-hover text-left group transition-colors"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`mr-1 text-c-muted transition-transform flex-shrink-0 ${isOpen ? "rotate-90" : ""}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-c-text-secondary group-hover:text-c-text truncate text-xs">{name}</span>
      </button>
      {isOpen && entries.map((entry) =>
        entry.type === "directory" ? (
          <DirectoryNode key={entry.path} path={entry.path} name={entry.name} depth={depth + 1} onSelectFile={onSelectFile} selectedFile={selectedFile} />
        ) : (
          <button
            key={entry.path}
            onClick={() => onSelectFile(entry.path)}
            className={`flex items-center w-full h-[22px] text-left truncate transition-colors ${
              selectedFile === entry.path
                ? "bg-c-accent-subtle text-c-text"
                : "text-c-muted hover:bg-c-surface-hover hover:text-c-text-secondary"
            }`}
            style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }}
          >
            <FileIcon name={entry.name} />
            <span className="truncate text-xs">{entry.name}</span>
          </button>
        )
      )}
    </div>
  );
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const colorMap: Record<string, string> = {
    ts: "text-blue-400", tsx: "text-blue-400", js: "text-yellow-400", jsx: "text-yellow-400",
    json: "text-yellow-600", css: "text-purple-400", html: "text-orange-400", md: "text-c-muted",
    py: "text-green-400", rs: "text-orange-500", go: "text-cyan-400", yaml: "text-red-300", yml: "text-red-300",
  };
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`mr-1.5 flex-shrink-0 ${colorMap[ext] ?? "text-c-muted/50"}`}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
