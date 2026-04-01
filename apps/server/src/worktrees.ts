import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const WORKTREE_DIR = ".conductor/worktrees";

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

  try {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
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
