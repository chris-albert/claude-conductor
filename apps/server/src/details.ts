import { execFileSync } from "child_process";
import { existsSync } from "fs";

export interface SessionDetails {
  cwd: string;
  isGitRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  modifiedCount: number;
  untrackedCount: number;
  stagedCount: number;
  remoteUrl?: string;
  githubUrl?: string;
  headSha?: string;
  headSubject?: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Convert a git remote URL into an https://github.com/... link, if it's a GitHub remote. */
function toGithubUrl(remote: string): string | undefined {
  // git@github.com:owner/repo.git → https://github.com/owner/repo
  const ssh = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  // https://github.com/owner/repo(.git)
  const https = remote.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return `https://github.com/${https[1]}/${https[2]}`;
  return undefined;
}

export function getSessionDetails(cwd: string): SessionDetails {
  const base: SessionDetails = {
    cwd,
    isGitRepo: false,
    modifiedCount: 0,
    untrackedCount: 0,
    stagedCount: 0,
  };

  if (!existsSync(cwd)) return base;

  // Cheap probe — is this a git repo?
  const inWorkTree = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inWorkTree !== "true") return base;
  base.isGitRepo = true;

  base.branch = git(["branch", "--show-current"], cwd) || undefined;

  // porcelain=v2 --branch gives ahead/behind on a "# branch.ab +N -N" line
  const porcelain = git(["status", "--porcelain=v2", "--branch"], cwd);
  if (porcelain !== null) {
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("# branch.ab ")) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          base.ahead = parseInt(m[1], 10);
          base.behind = parseInt(m[2], 10);
        }
      } else if (line.startsWith("? ")) {
        base.untrackedCount++;
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        // "1 XY ..." or "2 XY ..." — XY is two chars: index status, worktree status
        // X = staged, Y = unstaged
        const xy = line.slice(2, 4);
        const staged = xy[0];
        const unstaged = xy[1];
        if (staged !== "." && staged !== " ") base.stagedCount++;
        if (unstaged !== "." && unstaged !== " ") base.modifiedCount++;
      }
    }
  }

  const remote = git(["remote", "get-url", "origin"], cwd);
  if (remote) {
    base.remoteUrl = remote;
    base.githubUrl = toGithubUrl(remote);
  }

  base.headSha = git(["rev-parse", "--short", "HEAD"], cwd) || undefined;
  base.headSubject =
    git(["log", "-1", "--pretty=%s"], cwd) || undefined;

  return base;
}
