import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileTree } from "./FileTree";
import { useActiveTabs, openFile, closeTab, setActiveTab } from "../lib/store";
import { useSettings } from "../lib/settings";

type MdMode = "edit" | "split" | "inline";

interface EditorPaneProps {
  rootPath: string;
}

export function EditorPane({ rootPath }: EditorPaneProps) {
  const { openTabs: tabs, activeTab: activeFile } = useActiveTabs();
  const settings = useSettings();
  const [fileContent, setFileContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [mdMode, setMdMode] = useState<MdMode>("split");
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const isMarkdown = language === "markdown";

  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFileContent(data.content);
      setSavedContent(data.content);
      setLanguage(data.language);
      // Clear dirty flag for freshly loaded file
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } catch {
      setFileContent("// Error loading file");
      setSavedContent("");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeFile) loadFile(activeFile);
  }, [activeFile, loadFile]);

  const saveFile = useCallback(async () => {
    if (!activeFile) return;
    const content = editorRef.current?.getValue() ?? fileContent;
    setSaving(true);
    try {
      await fetch("/api/files/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activeFile, content }),
      });
      setSavedContent(content);
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        next.delete(activeFile);
        return next;
      });
    } catch {
      // save failed silently
    } finally {
      setSaving(false);
    }
  }, [activeFile, fileContent]);

  // Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveFile]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!activeFile || value === undefined) return;
      setFileContent(value);
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        if (value !== savedContent) {
          next.add(activeFile);
        } else {
          next.delete(activeFile);
        }
        return next;
      });
    },
    [activeFile, savedContent]
  );

  const handleSelectFile = useCallback((path: string) => {
    openFile(path);
  }, []);

  return (
    <div className="flex flex-col h-full bg-c-bg">
      {/* cwd path bar */}
      <div className="h-6 flex items-center px-3 border-b border-c-border-subtle flex-shrink-0">
        <span className="text-2xs text-c-muted font-mono truncate" title={rootPath}>
          {rootPath}
        </span>
      </div>

      {/* File tree + tabs + editor */}
      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div className="w-48 border-r border-c-border overflow-y-auto flex-shrink-0">
          <FileTree key={rootPath} rootPath={rootPath} onSelectFile={handleSelectFile} selectedFile={activeFile} />
        </div>

        {/* Tabs + editor */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar */}
          {tabs.length > 0 && (
            <div className="h-8 flex items-center border-b border-c-border overflow-x-auto flex-shrink-0">
              {tabs.map((tab) => {
                const name = tab.split("/").pop() ?? "";
                const isActive = tab === activeFile;
                const isDirty = dirtyFiles.has(tab);
                return (
                  <div
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`group flex items-center gap-1.5 h-full px-3 cursor-pointer border-r border-c-border-subtle text-xs whitespace-nowrap transition-colors ${
                      isActive
                        ? "bg-c-bg text-c-text border-b border-b-transparent relative -mb-px"
                        : "text-c-muted hover:text-c-text-secondary hover:bg-c-surface-hover"
                    }`}
                  >
                    <TabFileIcon name={name} />
                    <span className={isActive ? "font-medium" : ""}>{name}</span>
                    {isDirty && (
                      <span className="w-1.5 h-1.5 rounded-full bg-c-accent flex-shrink-0" title="Unsaved changes" />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
                      className="opacity-0 group-hover:opacity-100 text-c-muted hover:text-c-text w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-c-surface-active ml-0.5"
                    >
                      <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              <div className="ml-auto mr-2 flex items-center gap-2 flex-shrink-0">
                {isMarkdown && (
                  <div className="flex items-center bg-c-surface rounded overflow-hidden border border-c-border-subtle">
                    <MdModeButton
                      active={mdMode === "edit"}
                      onClick={() => setMdMode("edit")}
                      title="Source only"
                    >
                      {/* pencil icon */}
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </MdModeButton>
                    <MdModeButton
                      active={mdMode === "split"}
                      onClick={() => setMdMode("split")}
                      title="Split view"
                    >
                      {/* columns icon */}
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" />
                      </svg>
                    </MdModeButton>
                    <MdModeButton
                      active={mdMode === "inline"}
                      onClick={() => setMdMode("inline")}
                      title="Inline preview"
                    >
                      {/* eye icon */}
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                      </svg>
                    </MdModeButton>
                  </div>
                )}
                {(loading || saving) && (
                  <div className="flex items-center gap-1 text-2xs text-c-muted">
                    <span className="w-1 h-1 rounded-full bg-c-accent animate-pulse-subtle" />
                    {saving && <span>saving</span>}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Editor content */}
          {activeFile ? (
            isMarkdown && mdMode === "inline" ? (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <MarkdownInlineEditor
                  content={fileContent}
                  onChange={handleEditorChange}
                  fontSize={settings.editorFontSize}
                />
              </div>
            ) : (
            <div className="flex-1 flex min-h-0">
              {/* Monaco editor — full width or half when split */}
              <div className={isMarkdown && mdMode === "split" ? "w-1/2 border-r border-c-border" : "w-full"}>
                <Editor
                  theme="vs-dark"
                  language={language}
                  value={fileContent}
                  onChange={handleEditorChange}
                  onMount={(editor) => { editorRef.current = editor; }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: settings.editorFontSize,
                    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: "on",
                    padding: { top: 8 },
                    renderLineHighlight: "gutter",
                    guides: { indentation: true, bracketPairs: true },
                    smoothScrolling: true,
                    lineHeight: 18,
                  }}
                />
              </div>

              {/* Live markdown preview (split mode) */}
              {isMarkdown && mdMode === "split" && (
                <div className="w-1/2 overflow-y-auto">
                  <MarkdownPreview content={fileContent} />
                </div>
              )}
            </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 text-c-muted">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" />
                </svg>
                <p className="text-xs text-c-muted">Select a file</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MdModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-1.5 py-1 text-2xs transition-colors ${
        active
          ? "bg-c-accent/20 text-c-accent"
          : "text-c-muted hover:text-c-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Markdown block parser — every line is its own block, except fenced code
// blocks which are kept together. Empty lines are preserved as empty blocks.
// ---------------------------------------------------------------------------
function parseMarkdownBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  for (const line of lines) {
    const isFenceBoundary = /^(`{3,}|~{3,})/.test(line.trim());

    if (isFenceBoundary && !inFence) {
      inFence = true;
      fenceLines = [line];
      continue;
    }

    if (isFenceBoundary && inFence) {
      fenceLines.push(line);
      blocks.push(fenceLines.join("\n"));
      fenceLines = [];
      inFence = false;
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    // Regular line — one block per line (including empty lines)
    blocks.push(line);
  }

  // Unclosed fence — push each line individually
  for (const l of fenceLines) {
    blocks.push(l);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline markdown editor — renders blocks as preview; click to edit raw text
// ---------------------------------------------------------------------------
function MarkdownInlineEditor({
  content,
  onChange,
  fontSize,
}: {
  content: string;
  onChange: (value: string | undefined) => void;
  fontSize: number;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  // Snapshot of blocks taken when editing begins — isolates us from re-parses
  const [localBlocks, setLocalBlocks] = useState<string[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const parsedBlocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  const blocks = localBlocks ?? parsedBlocks;

  // Auto-size textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    }
  }, [editText, editingIdx]);

  // Focus the active edit element when editing starts
  useEffect(() => {
    if (editingIdx !== null) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus() ?? inputRef.current?.focus();
      });
    }
  }, [editingIdx]);

  const startEditing = (idx: number) => {
    if (editingIdx !== null && editingIdx !== idx) {
      // commit current edit first
      commitEdit();
    }
    const snapshot = localBlocks ?? [...parsedBlocks];
    setLocalBlocks(snapshot);
    setEditingIdx(idx);
    setEditText(snapshot[idx]);
  };

  const commitEdit = useCallback(() => {
    if (editingIdx === null) return;
    const newBlocks = [...(localBlocks ?? parsedBlocks)];
    newBlocks[editingIdx] = editText;
    setEditingIdx(null);
    setLocalBlocks(null);
    onChange(newBlocks.join("\n"));
  }, [editingIdx, editText, localBlocks, parsedBlocks, onChange]);

  const handleEditChange = (newText: string) => {
    setEditText(newText);
    // Sync to parent immediately (so Cmd+S saves latest)
    const newBlocks = [...(localBlocks ?? parsedBlocks)];
    newBlocks[editingIdx!] = newText;
    setLocalBlocks(newBlocks);
    onChange(newBlocks.join("\n"));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      commitEdit();
    }
  };

  // Click on the container background (not a block) → finish editing
  const handleContainerClick = (e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      commitEdit();
    }
  };

  return (
    <div
      ref={containerRef}
      className="px-6 py-4 h-full cursor-text"
      onClick={handleContainerClick}
    >
      {blocks.map((block, i) => {
        const isEmpty = block.trim() === "";
        const isMultiline = block.includes("\n"); // fenced code blocks

        // Empty lines render as spacing
        if (isEmpty && editingIdx !== i) {
          return (
            <div
              key={i}
              className="h-4 cursor-text"
              onClick={() => startEditing(i)}
            />
          );
        }

        return (
          <div key={i} className="relative group/block">
            {editingIdx === i ? (
              <div className="relative">
                <div className="absolute -left-3 top-0 bottom-0 w-0.5 rounded-full bg-c-accent/60" />
                {isMultiline ? (
                  <textarea
                    ref={textareaRef}
                    value={editText}
                    onChange={(e) => handleEditChange(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    className="w-full bg-transparent border border-c-border-subtle rounded px-3 py-1 font-mono text-c-text resize-none outline-none focus:border-c-accent/40 transition-colors"
                    style={{ fontSize }}
                  />
                ) : (
                  <input
                    ref={inputRef}
                    value={editText}
                    onChange={(e) => handleEditChange(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    className="w-full bg-transparent border border-c-border-subtle rounded px-3 py-0.5 font-mono text-c-text outline-none focus:border-c-accent/40 transition-colors"
                    style={{ fontSize }}
                  />
                )}
              </div>
            ) : (
              <div
                onClick={() => startEditing(i)}
                className="cursor-text rounded px-1 -mx-1 transition-colors hover:bg-c-surface/20"
              >
                <MdBlockPreview content={block} />
              </div>
            )}
          </div>
        );
      })}

      {/* Click area below last block to add content */}
      {blocks.length > 0 && (
        <div
          className="min-h-[120px]"
          onClick={() => {
            // Start editing the last block
            startEditing(blocks.length - 1);
          }}
        />
      )}
    </div>
  );
}

/** Renders a single markdown block as preview (used in inline editor) */
function MdBlockPreview({ content }: { content: string }) {
  return (
    <div className="prose-container">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Shared component overrides for markdown rendering */
const MD_COMPONENTS = {
  h1({ children }: { children?: React.ReactNode }) {
    return <h1 className="text-xl font-bold text-c-text mb-3 mt-5 pb-1.5 border-b border-c-border">{children}</h1>;
  },
  h2({ children }: { children?: React.ReactNode }) {
    return <h2 className="text-lg font-semibold text-c-text mb-2 mt-4 pb-1 border-b border-c-border-subtle">{children}</h2>;
  },
  h3({ children }: { children?: React.ReactNode }) {
    return <h3 className="text-sm font-semibold text-c-text mb-1.5 mt-3">{children}</h3>;
  },
  h4({ children }: { children?: React.ReactNode }) {
    return <h4 className="text-xs font-semibold text-c-text mb-1 mt-2">{children}</h4>;
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="text-[13px] text-c-text-secondary leading-relaxed mb-3">{children}</p>;
  },
  ul({ children }: { children?: React.ReactNode }) {
    return <ul className="text-[13px] text-c-text-secondary pl-5 mb-3 space-y-0.5 list-disc">{children}</ul>;
  },
  ol({ children }: { children?: React.ReactNode }) {
    return <ol className="text-[13px] text-c-text-secondary pl-5 mb-3 space-y-0.5 list-decimal">{children}</ol>;
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  blockquote({ children }: { children?: React.ReactNode }) {
    return <blockquote className="border-l-2 border-c-accent/40 pl-3 my-2 text-c-muted italic">{children}</blockquote>;
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-c-accent hover:text-c-accent-hover underline">{children}</a>;
  },
  hr() {
    return <hr className="border-c-border my-4" />;
  },
  table({ children }: { children?: React.ReactNode }) {
    return (
      <div className="overflow-x-auto mb-3">
        <table className="text-xs border-collapse w-full">{children}</table>
      </div>
    );
  },
  thead({ children }: { children?: React.ReactNode }) {
    return <thead className="border-b border-c-border">{children}</thead>;
  },
  th({ children }: { children?: React.ReactNode }) {
    return <th className="text-left px-3 py-1.5 text-c-text font-medium text-2xs">{children}</th>;
  },
  td({ children }: { children?: React.ReactNode }) {
    return <td className="px-3 py-1.5 text-c-text-secondary text-2xs border-b border-c-border-subtle">{children}</td>;
  },
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="bg-c-surface px-1 py-0.5 rounded text-[12px] font-mono text-c-accent" {...props}>
          {children}
        </code>
      );
    }
    return (
      <pre className="bg-c-surface border border-c-border-subtle rounded-md p-3 overflow-x-auto my-2">
        <code className="text-[12px] font-mono text-c-text-secondary leading-relaxed" {...props}>
          {children}
        </code>
      </pre>
    );
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    return <img src={src} alt={alt ?? ""} className="max-w-full rounded-md my-2 border border-c-border-subtle" />;
  },
  input({ checked, ...props }: { checked?: boolean }) {
    return (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="mr-1.5 accent-c-accent"
        {...props}
      />
    );
  },
};

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="px-6 py-4 prose-container md-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TabFileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const colorMap: Record<string, string> = {
    ts: "text-blue-400", tsx: "text-blue-400", js: "text-yellow-400", jsx: "text-yellow-400",
    json: "text-yellow-600", css: "text-purple-400", html: "text-orange-400",
    py: "text-green-400", rs: "text-orange-500", go: "text-cyan-400",
  };
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`flex-shrink-0 ${colorMap[ext] ?? "text-c-muted/50"}`}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
