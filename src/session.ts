// The school address and the saved Brightspace session, kept in one file on
// this computer that only the current user can read.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Cookie } from "./brightspace.js";

export class UsageError extends Error {
  override name = "UsageError";
}

const sessionSchema = z.object({
  origin: z.url({ protocol: /^https$/ }),
  cookies: z.array(z.object({ name: z.string().min(1), value: z.string() })),
  user: z.string().nullable(),
  savedAt: z.string(),
});

export type Session = z.infer<typeof sessionSchema>;

/** Where d2l-mcp keeps its files: D2L_MCP_HOME, or ~/.d2l-mcp. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.D2L_MCP_HOME?.trim() || join(homedir(), ".d2l-mcp");
}

/** "school.brightspace.com" or a full Brightspace URL, as an https origin. */
export function schoolOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new UsageError("Give your school's Brightspace address, like school.brightspace.com");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new UsageError(`"${trimmed}" isn't a web address. Use the address you open Brightspace at, like school.brightspace.com`);
  }
  if (url.protocol !== "https:") throw new UsageError("Brightspace addresses start with https://");
  if (url.username || url.password) throw new UsageError("Leave the username and password out of the address.");
  return url.origin;
}

const sessionFile = (dir: string) => join(dir, "session.json");

export async function readSession(dir: string): Promise<Session | null> {
  let text: string;
  try {
    text = await readFile(sessionFile(dir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = sessionSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export async function writeSession(
  dir: string,
  session: { origin: string; cookies: readonly Cookie[]; user: string | null },
): Promise<void> {
  // Tightened only when d2l-mcp made the folder, in case D2L_MCP_HOME points
  // at a folder the student uses for other things.
  if (await mkdir(dir, { recursive: true, mode: 0o700 })) await chmod(dir, 0o700);
  const saved = sessionSchema.parse({ ...session, cookies: [...session.cookies], savedAt: new Date().toISOString() });
  const temporary = `${sessionFile(dir)}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, sessionFile(dir));
}

/** Deletes the saved session and the sign-in browser profiles. */
export async function forget(dir: string, profiles: readonly string[]): Promise<void> {
  await rm(sessionFile(dir), { force: true });
  // Only folders that are browser profiles ("Local State" is in every one).
  for (const profile of profiles)
    if (existsSync(join(profile, "Local State"))) await rm(profile, { recursive: true, force: true });
}

/** Cookies from a pasted Cookie header ("a=1; b=2"). */
export function parseCookieHeader(header: string): Cookie[] {
  const cookies = header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const equals = part.indexOf("=");
      return equals > 0 ? { name: part.slice(0, equals).trim(), value: part.slice(equals + 1).trim() } : null;
    })
    .filter((cookie): cookie is Cookie => cookie !== null);
  if (cookies.length === 0) throw new UsageError('The cookie should look like "d2lSessionVal=...; d2lSecureSessionVal=..."');
  return cookies;
}
