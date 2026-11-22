// Signs in through a real browser window: the student uses their school's
// normal sign-in page (SSO, MFA and all), and the Brightspace cookies are read
// back over the Chrome DevTools Protocol. The protocol runs over a pipe, not a
// network port, so nothing else on the computer can connect to the window, and
// the browser quits if d2l-mcp does. The window has its own profile under the
// d2l-mcp folder; the student's everyday browser profile is never read.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import { createBrightspace, type Cookie, type Fetch, SignedOutError } from "./brightspace.js";

const POLL_MS = 1_500;
// How often to ask Brightspace again about cookies that haven't changed, in
// case the last check failed for a moment's network trouble.
const RECHECK_MS = 10_000;
// Backoff after Brightspace fails to answer (5xx, 429, network), doubling.
const TROUBLE_MS = 3_000;
const MAX_TROUBLE_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface Browser {
  readonly name: string;
  readonly path: string;
  /** Snap browsers on Linux can't open hidden folders, so they get their own. */
  readonly snap?: boolean;
}

/** Snap Chromium's profile, which must live inside the snap's own folder. */
export const SNAP_PROFILE = join(homedir(), "snap", "chromium", "common", "d2l-mcp-browser");

function isSnap(path: string): boolean {
  try {
    const real = realpathSync(path);
    return path.startsWith("/snap/") || real.startsWith("/snap/") || real === "/usr/bin/snap";
  } catch {
    return false;
  }
}

/** A Chromium browser on this computer, or D2L_MCP_BROWSER if set. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Browser | null {
  const custom = env.D2L_MCP_BROWSER?.trim();
  if (custom) return existsSync(custom) ? { name: "your browser", path: custom, ...(isSnap(custom) ? { snap: true } : {}) } : null;
  const candidates: [string, string][] = [];
  if (platform === "darwin") {
    for (const [name, app] of [
      ["Chrome", "Google Chrome"],
      ["Edge", "Microsoft Edge"],
      ["Brave", "Brave Browser"],
      ["Chromium", "Chromium"],
    ] as const)
      candidates.push([name, `/Applications/${app}.app/Contents/MacOS/${app}`]);
  } else if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      candidates.push(["Chrome", join(root, "Google", "Chrome", "Application", "chrome.exe")]);
      candidates.push(["Edge", join(root, "Microsoft", "Edge", "Application", "msedge.exe")]);
      candidates.push(["Brave", join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")]);
    }
  } else {
    for (const dir of (env.PATH ?? "").split(":").filter(Boolean))
      for (const [name, bin] of [
        ["Chrome", "google-chrome"],
        ["Chrome", "google-chrome-stable"],
        ["Edge", "microsoft-edge"],
        ["Brave", "brave-browser"],
        ["Chromium", "chromium"],
        ["Chromium", "chromium-browser"],
      ] as const)
        candidates.push([name, join(dir, bin)]);
  }
  const found = candidates.find(([, path]) => existsSync(path));
  if (!found) return null;
  const [name, path] = found;
  return platform === "linux" && name === "Chromium" && (isSnap(path) || existsSync("/snap/bin/chromium"))
    ? { name, path, snap: true }
    : { name, path };
}

const cdpCookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
});

/** The cookies a browser would send to this school's Brightspace API. */
export function schoolCookies(cookies: readonly z.infer<typeof cdpCookie>[], origin: string): Cookie[] {
  const host = new URL(origin).hostname;
  const picked = new Map<string, Cookie>();
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, "");
    const matches = host === domain || host.endsWith(`.${domain}`);
    if (cookie.name && matches && "/d2l/api/".startsWith(cookie.path.replace(/\/?$/, "/")) && !picked.has(cookie.name))
      picked.set(cookie.name, { name: cookie.name, value: cookie.value });
  }
  return [...picked.values()];
}

const reply = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** A DevTools Protocol connection over the browser's pipe (fds 3 and 4). */
class Cdp {
  #input: Writable;
  #next = 1;
  #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly closed: Promise<void>;

  constructor(child: ChildProcess) {
    const [, , , input, output] = child.stdio;
    if (!(input instanceof Writable) || !(output instanceof Readable)) throw new Error("The browser pipe isn't open");
    this.#input = input;
    input.on("error", () => undefined);
    let buffer = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
        this.#receive(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    this.closed = new Promise((resolve) => {
      const end = () => {
        for (const waiter of this.#waiting.values()) waiter.reject(new Error("The browser closed"));
        this.#waiting.clear();
        resolve();
      };
      child.once("exit", end);
      // A browser that can't be started emits "error" and never "exit".
      child.on("error", end);
    });
  }

  #receive(text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const message = reply.safeParse(data);
    if (!message.success) return;
    const waiter = this.#waiting.get(message.data.id);
    if (!waiter) return;
    this.#waiting.delete(message.data.id);
    if (message.data.error) waiter.reject(new Error(message.data.error.message));
    else waiter.resolve(message.data.result);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`The browser didn't answer ${method}`));
      }, timeoutMs);
      this.#waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#input.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the sign-in page in its own browser profile. */
async function openWindow(browser: Browser, profile: string, url: string): Promise<{ cdp: Cdp; child: ChildProcess }> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(
    browser.path,
    [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--new-window", url],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const cdp = new Cdp(child);
  try {
    await Promise.race([
      cdp.send("Browser.getVersion", {}, START_TIMEOUT_MS),
      cdp.closed.then(() => {
        throw new Error("exited");
      }),
    ]);
    return { cdp, child };
  } catch {
    child.kill();
    // A second browser on the same profile hands its window to the first one
    // and quits, which is the usual reason for getting here.
    throw new Error(`Couldn't open ${browser.name}. If a d2l-mcp sign-in window is already open, finish signing in there.`);
  }
}

export interface SignedIn {
  cookies: Cookie[];
  user: string;
}

/**
 * Opens a sign-in window at the school's Brightspace. Resolves once the
 * window is up; `finished` resolves when the student is signed in, or null if
 * they close the window or take longer than `timeoutMs`.
 */
export async function openSignIn({
  origin,
  dir,
  browser,
  fetch,
  timeoutMs = SIGN_IN_TIMEOUT_MS,
}: {
  origin: string;
  dir: string;
  browser: Browser;
  fetch?: Fetch;
  timeoutMs?: number;
}): Promise<{ finished: Promise<SignedIn | null> }> {
  const profile = browser.snap ? SNAP_PROFILE : join(dir, "browser");
  const { cdp, child } = await openWindow(browser, profile, `${origin}/d2l/home`);
  let closed = false;
  void cdp.closed.then(() => {
    closed = true;
  });
  // Lets the browser finish writing its profile (the school's "stay signed
  // in" cookies) before it is stopped; killing it at once loses them on Windows.
  const shutDown = async () => {
    if (!closed) {
      await cdp.send("Browser.close").catch(() => undefined);
      await Promise.race([cdp.closed, sleep(CLOSE_GRACE_MS)]);
    }
    if (!closed) child.kill();
  };

  const finished = (async (): Promise<SignedIn | null> => {
    let tried = "";
    let retryAt = 0;
    let trouble = TROUBLE_MS;
    // The first window can take a moment to appear after the browser starts.
    let sawPage = false;
    const deadline = Date.now() + timeoutMs;
    while (!closed && Date.now() < deadline) {
      await sleep(POLL_MS);
      let cookies: Cookie[];
      try {
        // On macOS the browser keeps running after its last window closes.
        const targets = z.object({ targetInfos: z.array(z.object({ type: z.string() })) }).parse(await cdp.send("Target.getTargets"));
        const hasPage = targets.targetInfos.some((target) => target.type === "page");
        if (sawPage && !hasPage) break;
        sawPage ||= hasPage;
        const answer = z.object({ cookies: z.array(cdpCookie) }).parse(await cdp.send("Storage.getCookies"));
        cookies = schoolCookies(answer.cookies, origin);
      } catch {
        continue;
      }
      const key = cookies.map(({ name, value }) => `${name}=${value}`).join(";");
      // Brightspace is asked when its cookies change, and now and then while
      // they don't, so it isn't polled while the student is on the school's
      // sign-in pages.
      if (cookies.length === 0 || (key === tried && Date.now() < retryAt)) continue;
      if (key !== tried) trouble = TROUBLE_MS;
      tried = key;
      try {
        const user = await createBrightspace({ origin, cookies, ...(fetch ? { fetch } : {}) }).whoami();
        await shutDown();
        return { cookies, user: user.name };
      } catch (error) {
        if (error instanceof SignedOutError) {
          retryAt = Date.now() + RECHECK_MS;
        } else {
          retryAt = Date.now() + trouble;
          trouble = Math.min(trouble * 2, MAX_TROUBLE_MS);
        }
      }
    }
    await shutDown();
    return null;
  })();
  return { finished };
}
