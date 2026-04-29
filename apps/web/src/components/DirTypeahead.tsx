import { useState, useRef, useEffect, useCallback } from "react";

interface DirTypeaheadProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  className?: string;
}

export function DirTypeahead({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = "Working directory...",
  className: inputClassName,
}: DirTypeaheadProps) {
  const [suggestions, setSuggestions] = useState<{ name: string; path: string }[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);

  const fetchDirs = useCallback((path: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/files/dirs?path=${encodeURIComponent(path)}`);
        const dirs = await res.json();
        setSuggestions(dirs);
        setSelectedIdx(-1);
        setShowSuggestions(dirs.length > 0);
      } catch {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    }, 100);
  }, []);

  const handleChange = (v: string) => {
    onChange(v);
    fetchDirs(v);
  };

  const selectSuggestion = (path: string) => {
    const withSlash = path.endsWith("/") ? path : path + "/";
    onChange(withSlash);
    setShowSuggestions(false);
    setSuggestions([]);
    inputRef.current?.focus();
    fetchDirs(withSlash);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && showSuggestions) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && showSuggestions) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab" && showSuggestions && suggestions.length > 0) {
      e.preventDefault();
      const idx = selectedIdx >= 0 ? selectedIdx : 0;
      selectSuggestion(suggestions[idx].path);
    } else if (e.key === "Enter") {
      if (showSuggestions && selectedIdx >= 0) {
        selectSuggestion(suggestions[selectedIdx].path);
      } else {
        onSubmit?.();
      }
    } else if (e.key === "Escape") {
      if (showSuggestions) {
        setShowSuggestions(false);
      } else {
        onCancel?.();
      }
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
        placeholder={placeholder}
        className={inputClassName ?? "w-full text-2xs font-mono bg-c-surface border border-c-border rounded px-1.5 py-1 text-c-text outline-none focus:border-c-accent/50"}
      />
      {showSuggestions && (
        <div className="absolute z-[100] left-0 right-0 mt-0.5 border border-c-border rounded shadow-lg max-h-32 overflow-y-auto" style={{ backgroundColor: "#1e1e2a" }}>
          {suggestions.map((s, i) => (
            <div
              key={s.path}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s.path); }}
              className={`flex items-center gap-1.5 px-1.5 py-1 cursor-pointer text-2xs font-mono ${
                i === selectedIdx
                  ? "bg-c-surface-active text-c-text"
                  : "text-c-text-secondary hover:bg-c-surface-hover"
              }`}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-c-accent flex-shrink-0">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              {s.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
