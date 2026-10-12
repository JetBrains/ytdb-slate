import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  killed?: boolean;
  timedOut?: boolean;
}

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  background?: boolean;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

const LOCAL_LIMIT_MS = 1000;
const REMOTE_LIMIT_MS = 10_000;
const OUTPUT_LIMIT = 32_768;

function errorText(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return "unknown error"; }
}

// Each child owns a process group. Stop descendants even if they ignore TERM.
export const runProcess: ProcessRunner = (request) => new Promise((resolveResult) => {
  if (request.signal.aborted) {
    resolveResult({ code: null, stdout: "", stderr: "", killed: true, error: "session ended" });
    return;
  }
  const child = spawn(request.command, request.args, {
    cwd: request.cwd, env: request.env, shell: false, detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  const stopGroup = () => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    }
  };
  const finish = (result: ProcessResult) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    process.removeListener("exit", stopGroup);
    stopGroup();
    child.stdout.destroy();
    child.stderr.destroy();
    resolveResult(result);
  };
  const cancel = () => finish({ code: null, stdout, stderr, killed: true, error: "session ended" });
  const timer = setTimeout(() => finish({
    code: null, stdout, stderr, killed: true, timedOut: true,
    error: `time limit of ${request.timeoutMs} ms exceeded`,
  }), request.timeoutMs);
  if (request.background) {
    // Exit cleanup also covers exits that skip session_shutdown.
    process.once("exit", stopGroup);
    timer.unref();
    child.unref();
    (child.stdout as typeof child.stdout & { unref?: () => void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.();
  }
  child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(0, OUTPUT_LIMIT); });
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(0, OUTPUT_LIMIT); });
  child.on("error", (error) => finish({ code: null, stdout, stderr, error: errorText(error) }));
  child.on("close", (code) => finish({ code, stdout, stderr }));
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
});

export function checkoutRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never", GIT_NO_LAZY_FETCH: "1",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes",
  };
}

function requireResult(result: ProcessResult): string {
  if (result.killed || result.timedOut || result.error || result.code !== 0) {
    throw new Error(result.error || (result.timedOut ? "time limit exceeded" : result.killed ? "git process was killed" : "")
      || result.stderr.trim() || `git exited ${result.code}`);
  }
  return result.stdout.trim();
}

function containedPath(directory: string, path: string): boolean {
  const difference = relative(realpathSync(directory), realpathSync(path));
  return difference !== "" && difference !== ".." && !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(difference);
}

export interface CheckOptions {
  root?: string;
  run?: ProcessRunner;
  localLimitMs?: number;
  remoteLimitMs?: number;
  stderr?: (message: string) => void;
}

export function registerMainWorktreeCheck(pi: ExtensionAPI, options: CheckOptions = {}) {
  const root = options.root ?? checkoutRoot();
  const main = resolve(root, "../main");
  const run = options.run ?? runProcess;
  const writeError = options.stderr ?? ((message: string) => { process.stderr.write(message); });
  let state: { active: boolean; controller: AbortController } | undefined;
  let background = Promise.resolve();

  const endSession = () => {
    if (!state) return;
    state.active = false;
    state.controller.abort();
  };
  pi.on("session_shutdown", endSession);
  pi.on("session_start", async (_event, ctx) => {
    endSession();
    const session = { active: true, controller: new AbortController() };
    state = session;
    const stderr = (message: string) => {
      try { writeError(`${message}\n`); } catch { /* A closed error stream has no delivery path. */ }
    };
    const report = (message: string, level: "error" | "warning") => {
      if (!session.active) return;
      try {
        const mode = ctx.mode;
        if (!session.active) return;
        if (mode === "print" || mode === "json") stderr(message);
        if (!session.active) return;
        const ui = ctx.ui;
        if (session.active) ui.notify(message, level);
      } catch (error) {
        if (session.active) stderr(`${message} Notification failed: ${errorText(error)}`);
      }
    };
    const git = (cwd: string, args: string[], timeoutMs = options.localLimitMs ?? LOCAL_LIMIT_MS,
      background = false) => run({
      command: "git", args: ["-c", "credential.helper=", "-c", "credential.interactive=false", ...args],
      cwd, env: gitEnvironment(), timeoutMs, signal: session.controller.signal, background,
    });
    const check = async (condition: string, remedy: string, operation: () => void | Promise<void>) => {
      try { await operation(); return session.active; }
      catch (error) {
        report(`Main worktree check failed: ${condition}. ${errorText(error)} Remedy: ${remedy}`, "error");
        return false;
      }
    };

    let valid = await check("sibling directory", `Run git worktree add ${JSON.stringify(main)} main.`, () => {
      if (!statSync(main).isDirectory()) throw new Error(`${main} is not a directory.`);
    });
    if (valid) valid = await check("slate package", "Use the ytdb-slate main worktree with extension/index.ts.", () => {
      if (!statSync(join(main, "extension/index.ts")).isFile()) throw new Error("The slate entry is not a file.");
      const manifest: unknown = JSON.parse(readFileSync(join(main, "package.json"), "utf8"));
      if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "ytdb-slate") {
        throw new Error("The package name must be ytdb-slate.");
      }
    });
    if (valid) valid = await check("shared Git repository", "Create main with git worktree add from this repository.", async () => {
      const common = async (directory: string) => realpathSync(resolve(directory,
        requireResult(await git(directory, ["rev-parse", "--git-common-dir"]))));
      if (await common(root) !== await common(main)) throw new Error("The Git common directories differ.");
    });
    if (valid) valid = await check("main branch", "Check out branch main in the sibling worktree.", async () => {
      if (requireResult(await git(main, ["symbolic-ref", "--quiet", "HEAD"])) !== "refs/heads/main") {
        throw new Error("The sibling does not have branch main checked out.");
      }
    });
    if (!session.active) return;
    await check("slate registration", "Load slate from the sibling main worktree through .pi/settings.json.", () => {
      const hasThread = pi.getAllTools().some((tool) => tool.name === "thread"
        && containedPath(main, tool.sourceInfo.path));
      if (!session.active) return;
      const command = pi.getCommands().find((command) => command.name === "slate" && command.source === "extension");
      if (!hasThread || !command || !containedPath(main, command.sourceInfo.path)) {
        throw new Error("The thread tool and /slate command must both be registered from main.");
      }
    });
    if (!valid || !session.active) return;

    const compareRemote = async () => {
      const query = (args: string[], timeoutMs = options.localLimitMs ?? LOCAL_LIMIT_MS) =>
        git(main, args, timeoutMs, true);
      const output = requireResult(await query(["ls-remote", "--exit-code", "--refs", "origin", "refs/heads/main"],
        options.remoteLimitMs ?? REMOTE_LIMIT_MS));
      if (!session.active) return;
      const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/heads\/main$/.exec(output);
      if (!match) throw new Error("The remote main response is missing or malformed.");
      const sha = match[1]!;
      const object = await query(["cat-file", "-e", `${sha}^{commit}`]);
      if (!session.active) return;
      if (object.killed || object.timedOut || object.error) requireResult(object);
      if (object.code === 1 || object.code === 128) {
        report(`Local main is behind remote main. The commit count is unknown because the remote commit is absent locally. Run git -C ${JSON.stringify(main)} pull.`, "warning");
        return;
      }
      requireResult(object);
      const ancestor = await query(["merge-base", "--is-ancestor", sha, "refs/heads/main"]);
      if (!session.active) return;
      if (ancestor.killed || ancestor.timedOut || ancestor.error) requireResult(ancestor);
      if (ancestor.code !== 1) { requireResult(ancestor); return; }
      const behind = await query(["merge-base", "--is-ancestor", "refs/heads/main", sha]);
      if (!session.active) return;
      if (behind.killed || behind.timedOut || behind.error) requireResult(behind);
      if (behind.code === 1) {
        report(`Local main has diverged from remote main. Inspect both histories in ${main} before pulling.`, "warning");
        return;
      }
      requireResult(behind);
      const count = requireResult(await query(["rev-list", "--count", `refs/heads/main..${sha}`]));
      if (!session.active) return;
      if (!/^\d+$/.test(count)) throw new Error("The behind commit count is malformed.");
      report(`Local main is behind remote main by ${count} commit(s). Run git -C ${JSON.stringify(main)} pull.`, "warning");
    };
    // Attach rejection handling immediately. Session start never awaits the remote.
    background = compareRemote().catch((error: unknown) => {
      report(`Remote main query failed: ${errorText(error)} Check origin, network access and authentication, then retry in the sibling worktree.`, "warning");
    });
  });
  return { idle: () => background };
}

export default function requireMainWorktree(pi: ExtensionAPI): void {
  registerMainWorktreeCheck(pi);
}
