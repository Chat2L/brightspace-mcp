// Gives the MCP tools a signed-in Brightspace client, and opens a sign-in
// window when the session is missing or expired.

import { type Browser, findBrowser, openSignIn } from "./browser.js";
import { type Brightspace, cookieHeader, createBrightspace, type Fetch, SignedOutError } from "./brightspace.js";
import { readSession, schoolOrigin, writeSession } from "./session.js";

export class NotSetUpError extends Error {
  override name = "NotSetUpError";
  constructor() {
    super(
      "Brightspace isn't set up on this computer yet. In a terminal, run `npx d2l-mcp login <your school's Brightspace address>` " +
        "(for example `npx d2l-mcp login school.brightspace.com`), or set BRIGHTSPACE_URL in this server's config.",
    );
  }
}

const ALREADY_OPEN = "A Brightspace sign-in window is already open. Ask the student to sign in there, then try again.";

export interface Auth {
  /** A client with the saved session. Throws NotSetUpError or SignedOutError. */
  brightspace(): Promise<Brightspace>;
  /** Starts signing in again, and says what the student should do. */
  signedOut(): Promise<string>;
}

export function createAuth({
  dir,
  school,
  fetch,
  browser = () => findBrowser(),
  open = openSignIn,
}: {
  dir: string;
  /** BRIGHTSPACE_URL from the server config, if set; wins over the saved school. */
  school?: string | undefined;
  fetch?: Fetch;
  browser?: () => Browser | null;
  open?: typeof openSignIn;
}): Auth {
  const configured = school?.trim() ? schoolOrigin(school) : null;
  const withFetch = fetch ? { fetch } : {};
  let client: { key: string; value: Brightspace } | null = null;
  // The sign-in in progress. Set before any await, so tool calls that arrive
  // together open one window between them.
  let signingIn: { message: Promise<string>; told: boolean } | null = null;

  async function brightspace(): Promise<Brightspace> {
    const session = await readSession(dir);
    const school = configured ?? session?.origin;
    if (!school) throw new NotSetUpError();
    const cookies = session?.origin === school ? session.cookies : [];
    if (cookies.length === 0) throw new SignedOutError();
    const key = `${school}\n${cookieHeader(cookies)}`;
    if (client?.key !== key) client = { key, value: createBrightspace({ origin: school, cookies, ...withFetch }) };
    return client.value;
  }

  /** Opens the window; resolves with what to tell the student and the wait for them. */
  async function start(): Promise<{ message: string; watching: Promise<void> | null }> {
    const school = configured ?? (await readSession(dir))?.origin;
    if (!school) return { message: new NotSetUpError().message, watching: null };
    const found = browser();
    if (!found)
      return {
        message:
          "The Brightspace session has expired, and no Chrome, Edge, Brave or Chromium was found to sign in with. " +
          `Ask the student to run \`npx d2l-mcp login ${new URL(school).host} --cookie\` in a terminal, then try again.`,
        watching: null,
      };
    try {
      const { finished } = await open({ origin: school, dir, browser: found, ...withFetch });
      const watching = finished.then(async (signedIn) => {
        if (signedIn) await writeSession(dir, { origin: school, ...signedIn });
      });
      return {
        message:
          `The student isn't signed in to Brightspace on this computer (or the session expired). A sign-in window for ${school} just opened in ${found.name}. ` +
          "Ask them to sign in there; the window closes by itself when it's done. Then try again.",
        watching,
      };
    } catch (error) {
      console.error("d2l-mcp: sign-in window failed:", error instanceof Error ? error.message : error);
      const reason = error instanceof Error ? ` ${error.message}` : "";
      return { message: `Signing in to Brightspace is needed, but the window couldn't open.${reason}`, watching: null };
    }
  }

  function signedOut(): Promise<string> {
    if (signingIn) {
      // Calls made together get the same answer; later ones learn it's open.
      if (!signingIn.told) return signingIn.message;
      return Promise.resolve(ALREADY_OPEN);
    }
    const started = start();
    const current = { message: started.then((result) => result.message), told: false };
    signingIn = current;
    current.message.then(
      () => {
        current.told = true;
      },
      () => undefined,
    );
    void started
      .then((result) => result.watching)
      .catch((error: unknown) => console.error("d2l-mcp: sign-in failed:", error instanceof Error ? error.message : error))
      .finally(() => {
        if (signingIn === current) signingIn = null;
      });
    return current.message;
  }

  return { brightspace, signedOut };
}
