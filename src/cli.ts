#!/usr/bin/env node
// d2l-mcp: with no command, runs the MCP server over stdio (what AI apps
// launch). The other commands are for the student in a terminal.

import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAuth } from "./auth.js";
import { join } from "node:path";
import { findBrowser, openSignIn, SIGN_IN_TIMEOUT_MS, SNAP_PROFILE } from "./browser.js";
import { BrightspaceError, createBrightspace, SignedOutError } from "./brightspace.js";
import { createServer, VERSION } from "./server.js";
import { dataDir, forget, parseCookieHeader, readSession, schoolOrigin, UsageError, writeSession } from "./session.js";

const HELP = `d2l-mcp ${VERSION}: a free Brightspace (D2L) MCP server

Usage:
  d2l-mcp login [school]     Sign in to Brightspace in a browser window and save the session
                             school: your Brightspace address, like school.brightspace.com
    --cookie                 Paste a Cookie header copied from your browser instead of
                             using a window (asked for, or read from stdin)
  d2l-mcp status             Show which school and account are saved
  d2l-mcp logout             Delete the saved session and sign-in browser profile
  d2l-mcp                    Run the MCP server (your AI app runs this)

Files live in ${dataDir()} (set D2L_MCP_HOME to move them).`;

function setupHint(): string {
  return `
Add it to your AI app:
  Claude Code:     claude mcp add brightspace -- npx -y d2l-mcp
  Codex:           codex mcp add brightspace -- npx -y d2l-mcp
  Claude Desktop, Cursor, Windsurf, VS Code and others, in the MCP config:
    "brightspace": { "command": "npx", "args": ["-y", "d2l-mcp"] }

Then ask something like "what's due this week?"`;
}

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function askSchool(): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError("Give your school's Brightspace address: d2l-mcp login school.brightspace.com");
  return ask("Your school's Brightspace address (like school.brightspace.com): ");
}

/** The Cookie header, typed at a prompt or piped in, so it stays out of shell history. */
async function readCookie(): Promise<string> {
  if (process.stdin.isTTY) return ask("Paste the Cookie header from a Brightspace API request: ");
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text.trim();
}

/** Checks the address answers like Brightspace before opening a window. */
async function checkSchool(origin: string): Promise<void> {
  let ok = false;
  try {
    const response = await fetch(new URL("/d2l/api/versions/", origin), { signal: AbortSignal.timeout(15_000) });
    ok = response.ok && (response.headers.get("content-type") ?? "").includes("json");
  } catch {
    throw new UsageError(`Couldn't reach ${origin}. Check the address and your internet connection.`);
  }
  if (!ok) throw new UsageError(`${origin} doesn't look like a Brightspace site. Use the address you open Brightspace at.`);
}

async function login(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("-"));
  const unknown = flags.find((flag) => flag !== "--cookie");
  if (unknown === "--help" || unknown === "-h") {
    console.log(HELP);
    return;
  }
  if (unknown) throw new UsageError(`Unknown option "${unknown}".\n\n${HELP}`);
  const [school, extra] = args.filter((arg) => !arg.startsWith("-"));
  if (extra) throw new UsageError(`Unexpected "${extra}". Usage: d2l-mcp login [school] [--cookie]`);
  const dir = dataDir();
  const saved = await readSession(dir);
  const origin = schoolOrigin(school ?? saved?.origin ?? (await askSchool()));
  await checkSchool(origin);
  const cookie = flags.includes("--cookie") ? await readCookie() : null;

  if (cookie !== null) {
    const cookies = parseCookieHeader(cookie);
    const user = await createBrightspace({ origin, cookies }).whoami();
    await writeSession(dir, { origin, cookies, user: user.name });
    console.log(`Signed in to ${origin} as ${user.name}.`);
    console.log(setupHint());
    return;
  }

  const browser = findBrowser();
  if (!browser)
    throw new UsageError(
      "No Chrome, Edge, Brave or Chromium found. Install one, set D2L_MCP_BROWSER to a Chromium browser, or run login with --cookie.",
    );
  console.log(`Opening ${browser.name}. Sign in to Brightspace there; the window closes by itself when you're in.`);
  const { finished } = await openSignIn({ origin, dir, browser }).catch((error: unknown) => {
    throw new UsageError(error instanceof Error ? error.message : `Couldn't open ${browser.name}.`);
  });
  const signedIn = await finished;
  if (!signedIn)
    throw new UsageError(`Sign-in didn't finish (window closed, or over ${SIGN_IN_TIMEOUT_MS / 60_000} minutes). Run login again.`);
  await writeSession(dir, { origin, ...signedIn });
  console.log(`Signed in to ${origin} as ${signedIn.user}. Session saved in ${dir}.`);
  console.log(setupHint());
}

async function status(): Promise<void> {
  const session = await readSession(dataDir());
  if (!session) {
    console.log("Not set up. Run: d2l-mcp login school.brightspace.com");
    return;
  }
  try {
    const user = await createBrightspace(session).whoami();
    console.log(`Signed in to ${session.origin} as ${user.name}.`);
  } catch (error) {
    if (!(error instanceof SignedOutError)) throw error;
    console.log(`Saved school: ${session.origin}. The session has expired; your AI app will open a sign-in window when needed, or run: d2l-mcp login`);
  }
}

async function serve(): Promise<void> {
  const auth = createAuth({ dir: dataDir(), school: process.env.BRIGHTSPACE_URL });
  const server = createServer(auth);
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case undefined:
      return serve();
    case "login":
      return login(args);
    case "status":
      return status();
    case "logout":
      await forget(dataDir(), [join(dataDir(), "browser"), SNAP_PROFILE]);
      console.log("Deleted the saved Brightspace session and sign-in profile.");
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError || error instanceof BrightspaceError) console.error(error.message);
  else if (error instanceof SignedOutError) console.error("Brightspace didn't accept that sign-in. Check the cookie or run login without --cookie.");
  else console.error(error);
  process.exitCode = 1;
});
