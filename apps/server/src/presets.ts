import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface SlotSpec {
  name: string;
  /** If set, conductor uses this exact port instead of allocating a free one. */
  port?: number;
}

export interface ProcessPreset {
  name: string;
  description?: string;
  command: string;
  slots?: SlotSpec[];
}

interface PresetsFile {
  processes?: unknown;
}

const CONFIG_FILE = "conductor.config.json";

/**
 * Load process presets from <cwd>/conductor.config.json.
 * Returns an empty list if the file is missing, malformed, or has no processes.
 * Validation is permissive: bad entries are skipped, good ones are kept.
 */
export function loadPresets(cwd: string): ProcessPreset[] {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return [];
  let data: PresetsFile;
  try {
    data = JSON.parse(readFileSync(file, "utf-8")) as PresetsFile;
  } catch {
    return [];
  }
  if (!Array.isArray(data.processes)) return [];

  const presets: ProcessPreset[] = [];
  for (const raw of data.processes) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== "string" || typeof p.command !== "string") continue;
    presets.push({
      name: p.name,
      command: p.command,
      description: typeof p.description === "string" ? p.description : undefined,
      slots: Array.isArray(p.slots) ? parseSlots(p.slots) : undefined,
    });
  }
  return presets;
}

function parseSlots(raw: unknown[]): SlotSpec[] {
  const out: SlotSpec[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ name: entry });
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string") continue;
      const port = typeof e.port === "number" && Number.isFinite(e.port) && e.port > 0
        ? Math.floor(e.port)
        : undefined;
      out.push({ name: e.name, port });
    }
  }
  return out;
}
