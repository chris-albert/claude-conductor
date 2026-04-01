import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface SessionEvent {
  type:
    | "message"
    | "tool_use"
    | "tool_result"
    | "error"
    | "session_complete"
    | "session_info"
    | "usage_update"
    | "auth_status"
    | "port_change"
    | "process_update";
  data: unknown;
}

export interface SessionOptions {
  model?: string;
  permissionMode?: string;
  sdkSessionId?: string;
}

/**
 * Ensure permission settings exist so Claude Code auto-allows all tools.
 * Writes to both the user's global ~/.claude/settings.local.json AND the
 * project's .claude/settings.local.json to cover all cases.
 */
function ensurePermissionSettings(cwd: string) {
  const settings = {
    permissions: {
      allow: [
        "Bash(*)",
        "Read(*)",
        "Edit(*)",
        "Write(*)",
        "Glob(*)",
        "Grep(*)",
        "Agent(*)",
      ],
      deny: [],
    },
  };

  // Write to user's global settings (covers v2 sessions that start without cwd)
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/home/conductor";
  const globalClaudeDir = join(homeDir, ".claude");
  const globalSettingsPath = join(globalClaudeDir, "settings.local.json");
  writeSettingsIfNeeded(globalClaudeDir, globalSettingsPath, settings);

  // Also write to the project directory
  const projectClaudeDir = join(cwd, ".claude");
  const projectSettingsPath = join(projectClaudeDir, "settings.local.json");
  writeSettingsIfNeeded(projectClaudeDir, projectSettingsPath, settings);
}

function writeSettingsIfNeeded(dir: string, path: string, settings: Record<string, unknown>) {
  try {
    if (existsSync(path)) {
      // Check if it already has permission settings
      const existing = JSON.parse(require("fs").readFileSync(path, "utf-8"));
      if (existing?.permissions?.allow?.length > 0) return;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2));
  } catch {
    // Best effort — don't crash if we can't write settings
  }
}

/** Whether we've patched the SDK internals */
let sdkPatched = false;

/**
 * Patch the SDK's ProcessTransport to inject our permission mode and tools.
 * The v2 API hardcodes permissionMode: "default" with no way to override.
 * We patch the prototype's initialize method to fix the options before
 * the CLI process is spawned.
 */
async function patchSdkIfNeeded(cwd: string) {
  if (sdkPatched) return;

  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  // Create a dummy session to extract the ProcessTransport class
  const dummy = sdk.unstable_v2_createSession({ model: "claude-sonnet-4-6" }) as unknown as Record<string, unknown>;
  const queryInstance = dummy.query as Record<string, unknown>;
  const transport = queryInstance.transport as Record<string, unknown>;
  const ProcessTransport = transport.constructor as { prototype: Record<string, unknown> };

  // Patch initialize to override permission settings and cwd
  const origInit = ProcessTransport.prototype.initialize as () => void;
  ProcessTransport.prototype.initialize = function (this: Record<string, unknown>) {
    const opts = this.options as Record<string, unknown>;
    opts.permissionMode = "bypassPermissions";
    opts.allowDangerouslySkipPermissions = true;
    opts.allowedTools = ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"];
    // Set cwd if the session has one stored (via our custom env var)
    const envCwd = (opts.env as Record<string, string> | undefined)?.CONDUCTOR_SESSION_CWD;
    if (envCwd) {
      opts.cwd = envCwd;
    }
    return origInit.call(this);
  };

  // Kill the dummy session
  try { (dummy as { close(): void }).close(); } catch { /* */ }
  sdkPatched = true;
}

/**
 * Manages a persistent Claude Code session using the v2 SDK API.
 * The underlying process stays alive between prompts, so background
 * processes (dev servers, etc.) survive across conversation turns.
 */
export class AgentSession {
  private session: { sessionId: string; send(m: string): Promise<void>; stream(): AsyncGenerator<unknown>; close(): void } | null = null;
  private cwd: string;
  private _sdkSessionId: string | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  get sdkSessionId(): string | null {
    return this._sdkSessionId;
  }

  set sdkSessionId(id: string | null) {
    this._sdkSessionId = id;
  }

  private async createSession(model: string, resumeId?: string) {
    await patchSdkIfNeeded(this.cwd);
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const opts = {
      model,
      env: {
        ...process.env,
        CONDUCTOR_SESSION_CWD: this.cwd,
      },
    };

    if (resumeId) {
      try {
        return sdk.unstable_v2_resumeSession(resumeId, opts) as unknown as typeof this.session;
      } catch {
        return sdk.unstable_v2_createSession(opts) as unknown as typeof this.session;
      }
    }
    return sdk.unstable_v2_createSession(opts) as unknown as typeof this.session;
  }

  async *sendPrompt(
    prompt: string,
    opts?: SessionOptions
  ): AsyncGenerator<SessionEvent> {
    // Create or reuse the persistent session
    if (!this.session) {
      const model = opts?.model ?? "claude-sonnet-4-6";
      const resumeId = opts?.sdkSessionId ?? this._sdkSessionId ?? undefined;
      this.session = await this.createSession(model, resumeId);
    }

    // Wrap prompt with process management instruction
    const wrappedPrompt = `<conductor_system>
You are running inside Conductor. Long-running processes (dev servers, watchers, etc.) started via the Bash tool WILL BE KILLED when the tool completes.

RULES:
1. DO run setup commands yourself via Bash: install dependencies (npm install, pnpm install, pip install, etc.), build steps, database migrations, config generation, etc.
2. DO NOT start long-running processes (dev servers, watchers, file servers) via Bash — they will be killed.
3. After completing all setup, tell the user the exact command to start the server and tell them to run it in the **Processes panel** at the bottom of the chat.

Example good flow when asked "start the dev server":
- Run \`pnpm install\` via Bash (setup — fine)
- Run any build/codegen steps via Bash (setup — fine)
- Then say: "Setup complete! Run \`pnpm dev\` in the Processes panel to start the dev server."

Example bad flow:
- Running \`pnpm dev\` via Bash (will be killed!)
</conductor_system>

${prompt}`;

    // Send the prompt
    try {
      await this.session!.send(wrappedPrompt);
    } catch {
      // Session might be stale — recreate
      try { this.session!.close(); } catch { /* */ }
      const model = opts?.model ?? "claude-sonnet-4-6";
      this.session = await this.createSession(model);
      await this.session!.send(wrappedPrompt);
    }

    const seenUUIDs = new Set<string>();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    try {
      for await (const raw of this.session!.stream()) {
        const anyMsg = raw as Record<string, unknown>;

        // System init
        if (anyMsg.type === "system" && anyMsg.subtype === "init") {
          this._sdkSessionId = anyMsg.session_id as string;
          yield {
            type: "session_info",
            data: {
              model: anyMsg.model,
              tools: anyMsg.tools,
              cwd: anyMsg.cwd,
              version: anyMsg.claude_code_version,
              sdkSessionId: anyMsg.session_id,
            },
          };
          continue;
        }

        // Auth status
        if (anyMsg.type === "auth_status") {
          yield {
            type: "auth_status",
            data: {
              isAuthenticating: anyMsg.isAuthenticating,
              output: anyMsg.output,
              error: anyMsg.error,
            },
          };
          continue;
        }

        // Skip replays
        if (anyMsg.isReplay) continue;

        // User messages → extract tool results
        if (anyMsg.type === "user") {
          const content =
            (anyMsg.message as Record<string, unknown>)?.content ??
            anyMsg.content;
          if (Array.isArray(content)) {
            for (const block of content as Record<string, unknown>[]) {
              if (block.type === "tool_result") {
                const raw2 = block.content ?? block.output ?? block.text ?? "";
                let text: string;
                if (typeof raw2 === "string") text = raw2;
                else if (Array.isArray(raw2))
                  text = (raw2 as Record<string, unknown>[]).map((c) => (c.text as string) ?? "").join("");
                else text = JSON.stringify(raw2);
                const toolUseId = (block.tool_use_id as string) ?? (block.toolUseId as string) ?? "";
                if (text || toolUseId) {
                  yield { type: "tool_result" as const, data: { toolUseId, content: text } };
                }
              }
            }
          }
          continue;
        }

        // Assistant messages
        if (anyMsg.type === "assistant") {
          const uuid = anyMsg.uuid as string;
          if (seenUUIDs.has(uuid)) continue;
          seenUUIDs.add(uuid);

          const message = anyMsg.message as Record<string, unknown>;
          const usage = message?.usage as Record<string, number> | undefined;
          if (usage) {
            totalInputTokens += usage.input_tokens ?? 0;
            totalOutputTokens += usage.output_tokens ?? 0;
            totalCacheRead += usage.cache_read_input_tokens ?? 0;
            totalCacheCreation += usage.cache_creation_input_tokens ?? 0;
            yield {
              type: "usage_update",
              data: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                cacheRead: totalCacheRead,
                cacheCreation: totalCacheCreation,
                totalTokens: totalInputTokens + totalOutputTokens,
              },
            };
          }

          const content = message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Record<string, unknown>[]) {
              if (block.type === "text") {
                yield { type: "message", data: { text: block.text } };
              } else if (block.type === "tool_use") {
                yield {
                  type: "tool_use",
                  data: {
                    id: block.id,
                    name: block.name,
                    input: block.input,
                    parentToolUseId: anyMsg.parent_tool_use_id,
                  },
                };
              }
            }
          }
          continue;
        }

        // Result
        if (anyMsg.type === "result") {
          if (anyMsg.session_id) this._sdkSessionId = anyMsg.session_id as string;

          let contextWindow = 0;
          const modelUsage = anyMsg.modelUsage as Record<string, Record<string, number>> | undefined;
          if (modelUsage) {
            for (const mu of Object.values(modelUsage)) {
              if (mu.contextWindow > contextWindow) contextWindow = mu.contextWindow;
            }
          }

          if (anyMsg.subtype === "success") {
            yield {
              type: "session_complete" as const,
              data: {
                cost: anyMsg.total_cost_usd,
                duration: anyMsg.duration_ms,
                turns: anyMsg.num_turns,
                contextWindow,
                sdkSessionId: anyMsg.session_id,
                usage: {
                  inputTokens: (anyMsg.usage as Record<string, number>)?.input_tokens,
                  outputTokens: (anyMsg.usage as Record<string, number>)?.output_tokens,
                },
              },
            };
          } else {
            const errors = anyMsg.errors as string[] | undefined;
            yield {
              type: "error",
              data: {
                message: errors?.join("\n") ?? `Session ended: ${anyMsg.subtype}`,
                cost: anyMsg.total_cost_usd,
                duration: anyMsg.duration_ms,
              },
            };
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const fullMessage = error.message;

      const is401 = fullMessage.includes("status code 401") || fullMessage.includes("Unauthorized");
      if (is401) {
        yield {
          type: "auth_status",
          data: { isAuthenticating: false, output: [], error: "Authentication failed (401). Please re-authenticate." },
        };
      }

      yield {
        type: "error",
        data: {
          message: is401 ? "Authentication failed — please re-authenticate and try again." : fullMessage,
          stack: error.stack ?? null,
          cwd: this.cwd,
        },
      };

      // Session is broken — clear so next prompt creates fresh
      this.session = null;
    }
  }

  close() {
    if (this.session) {
      try { this.session.close(); } catch { /* */ }
      this.session = null;
    }
  }
}
