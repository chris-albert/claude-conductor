import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ProcessPreset {
  name: string;
  description?: string;
  command: string;
  slots?: string[];
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
      slots: Array.isArray(p.slots)
        ? p.slots.filter((s): s is string => typeof s === "string")
        : undefined,
    });
  }
  return presets;
}
