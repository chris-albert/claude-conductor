import { execFileSync } from "child_process";

/**
 * The conductor server's own PID and every ancestor up to PID 1. Computed once
 * at startup. Any kill path consults this set to make sure we never SIGTERM
 * ourselves, our shell, turbo, or whatever spawned us. Without this guard, a
 * runner whose descendant tree happens to overlap with conductor's host (e.g.
 * `pnpm dev` of the same monorepo) would take out the whole stack on cleanup.
 */
const PROTECTED = computeAncestorChain();

function computeAncestorChain(): Set<number> {
  const chain = new Set<number>([process.pid]);
  let stdout = "";
  try {
    stdout = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf-8",
      timeout: 3000,
    });
  } catch {
    return chain;
  }
  const ppidByPid = new Map<number, number>();
  for (const line of stdout.trim().split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    ppidByPid.set(parseInt(m[1], 10), parseInt(m[2], 10));
  }
  let cur = process.pid;
  for (let i = 0; i < 50; i++) {
    const ppid = ppidByPid.get(cur);
    if (!ppid || ppid <= 1) break;
    chain.add(ppid);
    cur = ppid;
  }
  return chain;
}

export function isProtectedPid(pid: number): boolean {
  return pid <= 0 || PROTECTED.has(pid);
}

export function getProtectedPids(): ReadonlySet<number> {
  return PROTECTED;
}
