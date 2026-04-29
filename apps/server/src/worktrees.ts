import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";

const WORKTREE_DIR = ".conductor/worktrees";

const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "calm", "clever", "cosmic", "crimson",
  "crisp", "dapper", "deep", "eager", "ember", "fierce", "frost", "gentle",
  "golden", "happy", "hidden", "ivory", "jade", "keen", "lively", "lucky",
  "mellow", "merry", "misty", "mossy", "noble", "nimble", "pearl", "plucky",
  "proud", "quick", "quiet", "rapid", "ruby", "rustic", "shadow", "silent",
  "silver", "smooth", "solar", "spry", "stormy", "sunny", "swift", "tidal",
  "topaz", "twilight", "valiant", "velvet", "vivid", "wild", "witty", "zesty",
];

const NOUNS = [
  "badger", "beaver", "bison", "bobcat", "cheetah", "chipmunk", "coyote",
  "crane", "deer", "dolphin", "eagle", "elk", "falcon", "ferret", "finch",
  "fox", "gecko", "hawk", "heron", "ibis", "iguana", "jaguar", "koala",
  "lemur", "leopard", "lynx", "magpie", "marten", "moose", "newt", "ocelot",
  "orca", "otter", "owl", "panda", "panther", "pelican", "penguin", "puma",
  "quail", "rabbit", "raccoon", "raven", "robin", "salmon", "seal", "shark",
  "sloth", "sparrow", "stingray", "stoat", "swan", "tiger", "trout", "turtle",
  "viper", "walrus", "weasel", "whale", "wolf", "wombat", "yak", "zebra",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a friendly worktree name (e.g. "swift-otter").
 * Retries on collision; falls back to appending a short hex suffix if all
 * retries collide (vanishingly unlikely given ~3500 combinations).
 */
export function generateWorktreeName(projectRoot: string): string {
  const worktreeDir = join(projectRoot, WORKTREE_DIR);
  for (let i = 0; i < 10; i++) {
    const candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!existsSync(join(worktreeDir, candidate))) return candidate;
  }
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(2).toString("hex")}`;
}

export function ensureWorktreeDir(projectRoot: string): string {
  const dir = join(projectRoot, WORKTREE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function createWorktree(projectRoot: string, name: string): string {
  const worktreeDir = ensureWorktreeDir(projectRoot);
  const worktreePath = join(worktreeDir, name);

  if (existsSync(worktreePath)) {
    return worktreePath;
  }

  const branchName = `conductor-${name}`;
  // Verify HEAD exists (repo must have at least one commit)
  try {
    execSync("git rev-parse HEAD", { cwd: projectRoot, stdio: "pipe" });
  } catch {
    throw new Error(
      "Cannot create worktree: repository has no commits. Make an initial commit first."
    );
  }

  // Fetch latest from origin and determine the main branch
  let startPoint = "HEAD";
  try {
    execSync("git fetch origin", { cwd: projectRoot, stdio: "pipe", timeout: 30_000 });
    // Try origin/main, then origin/master
    for (const candidate of ["origin/main", "origin/master"]) {
      try {
        execSync(`git rev-parse --verify ${candidate}`, { cwd: projectRoot, stdio: "pipe" });
        startPoint = candidate;
        break;
      } catch { /* try next */ }
    }
  } catch {
    // Fetch failed (offline, no remote) — fall back to HEAD
  }

  try {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}" ${startPoint}`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    // Branch might already exist, try without -b
    try {
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Worktree from detached HEAD
      execSync(`git worktree add "${worktreePath}"`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    }
  }

  return worktreePath;
}

export function removeWorktree(projectRoot: string, name: string): void {
  const worktreePath = join(projectRoot, WORKTREE_DIR, name);
  if (!existsSync(worktreePath)) return;

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    // Fallback: prune and remove manually
    rmSync(worktreePath, { recursive: true, force: true });
    execSync("git worktree prune", { cwd: projectRoot, stdio: "pipe" });
  }

  // Clean up the branch
  const branchName = `conductor-${name}`;
  try {
    execSync(`git branch -D "${branchName}"`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    // Branch may not exist, that's fine
  }
}

export function listWorktrees(
  projectRoot: string
): Array<{ path: string; branch: string; name: string }> {
  const worktreeDir = join(projectRoot, WORKTREE_DIR);
  if (!existsSync(worktreeDir)) return [];

  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    const worktrees: Array<{ path: string; branch: string; name: string }> = [];
    const blocks = output.trim().split("\n\n");

    for (const block of blocks) {
      const lines = block.split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      const branchLine = lines.find((l) => l.startsWith("branch "));

      if (pathLine) {
        const wtPath = pathLine.replace("worktree ", "");
        if (wtPath.includes(WORKTREE_DIR)) {
          const name = wtPath.split("/").pop() ?? "";
          const branch = branchLine?.replace("branch refs/heads/", "") ?? "";
          worktrees.push({ path: wtPath, branch, name });
        }
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}
