import { readFile, writeFile, readdir, stat, watch } from "fs/promises";
import { join, relative } from "path";
import { EventEmitter } from "events";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  ".next",
  "__pycache__",
  ".conductor",
]);

export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const results: FileEntry[] = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
    results.push({
      name: entry.name,
      path: join(dirPath, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
    });
  }

  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

export async function readFileContent(
  filePath: string
): Promise<{ content: string; language: string }> {
  const content = await readFile(filePath, "utf-8");
  const language = getLanguageFromPath(filePath);
  return { content, language };
}

export async function writeFileContent(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf-8");
}

export async function getFileStats(filePath: string) {
  const s = await stat(filePath);
  return { size: s.size, modified: s.mtime.toISOString(), isDirectory: s.isDirectory() };
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    graphql: "graphql",
    xml: "xml",
    svg: "xml",
  };
  return map[ext] ?? "plaintext";
}

export class FileWatcher extends EventEmitter {
  private abortControllers = new Map<string, AbortController>();

  async watchDirectory(rootPath: string, label: string) {
    if (this.abortControllers.has(label)) return;

    const ac = new AbortController();
    this.abortControllers.set(label, ac);

    try {
      const watcher = watch(rootPath, { recursive: true, signal: ac.signal });
      for await (const event of watcher) {
        if (event.filename && !shouldIgnoreFile(event.filename)) {
          this.emit("change", {
            label,
            eventType: event.eventType,
            filename: event.filename,
            fullPath: join(rootPath, event.filename),
          });
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    }
  }

  stopWatching(label: string) {
    const ac = this.abortControllers.get(label);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(label);
    }
  }

  stopAll() {
    for (const [label] of this.abortControllers) {
      this.stopWatching(label);
    }
  }
}

function shouldIgnoreFile(filename: string): boolean {
  const parts = filename.split("/");
  return parts.some((p) => IGNORED.has(p) || p.startsWith("."));
}
