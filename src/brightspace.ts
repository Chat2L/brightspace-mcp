// Read-only calls to the Brightspace (Valence) API with a student's own
// session cookies. Every request stays on the school's origin.

import { arr, num, obj, str } from "./values.js";

export type Fetch = typeof globalThis.fetch;
export type Product = "le" | "lp";

export interface Cookie {
  readonly name: string;
  readonly value: string;
}

type Versions = Record<Product, string>;

// The oldest versions D2L still answers for every route used here. Used only
// when the school's own version list can't be read.
const FALLBACK_VERSIONS: Versions = { le: "1.82", lp: "1.49" };
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 20;
const MAX_ENROLLMENT_PAGES = 50;
const USER_AGENT = "d2l-mcp (+https://github.com/Chat2L/brightspace-mcp)";

export class SignedOutError extends Error {
  override name = "SignedOutError";
  constructor() {
    super("Not signed in to Brightspace");
  }
}

export class BrightspaceError extends Error {
  override name = "BrightspaceError";
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

function statusMessage(status: number): string {
  if (status === 403) return "Brightspace says this student can't see that (403).";
  if (status === 404) return "Brightspace couldn't find that (404). Check the course id with list_courses.";
  if (status === 429) return "Brightspace is limiting requests right now. Wait a minute and try again.";
  if (status >= 500) return `Brightspace had an error (${status}). Try again in a bit.`;
  return `Brightspace refused the request (${status}).`;
}

export function cookieHeader(cookies: readonly Cookie[]): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

function readVersions(data: unknown): Versions {
  const versions = { ...FALLBACK_VERSIONS };
  for (const entry of arr(data)) {
    const product = obj(entry);
    const code = str(product?.ProductCode);
    const latest = str(product?.LatestVersion);
    if ((code === "le" || code === "lp") && latest && /^\d+\.\d+$/.test(latest)) versions[code] = latest;
  }
  return versions;
}

function validTimeZone(zone: string | null): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface Brightspace {
  readonly origin: string;
  /** One API answer, e.g. get("le", "123/news/"). */
  get(product: Product, path: string): Promise<unknown>;
  /** Every object of a list D2L pages with `Next` links. */
  pages(product: Product, path: string): Promise<unknown[]>;
  /** Every enrollment item, across bookmark pages. */
  enrollments(): Promise<unknown[]>;
  whoami(): Promise<{ id: string; name: string }>;
  /** The school's time zone, for showing dates the way students see them. */
  timeZone(): Promise<string>;
}

export function createBrightspace({
  origin,
  cookies,
  fetch = globalThis.fetch,
}: {
  origin: string;
  cookies: readonly Cookie[];
  fetch?: Fetch;
}): Brightspace {
  const header = cookieHeader(cookies);
  let versions: Promise<Versions> | undefined;
  let zone: Promise<string> | undefined;

  /**
   * `session`: a 403 is checked against whoami. `probe`: a 403 means no
   * session (whoami, enrollments). `public`: sent without the cookie.
   */
  async function request(url: URL, mode: "session" | "probe" | "public" = "session"): Promise<unknown> {
    if (url.origin !== origin) throw new BrightspaceError("Refused an address outside the school's Brightspace.");
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(mode === "public" ? {} : { Cookie: header }) },
        // Without a session the API redirects to the sign-in page.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new BrightspaceError(timedOut ? "Brightspace took too long to answer." : "Couldn't reach Brightspace.");
    }
    const type = response.headers.get("content-type") ?? "";
    const redirected = response.status >= 300 && response.status < 400;
    const loginPage = response.ok && type.includes("text/html");
    if (mode !== "public" && (response.status === 401 || redirected || loginPage || (mode === "probe" && response.status === 403))) {
      await response.body?.cancel();
      throw new SignedOutError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Course routes answer an expired session with a plain 403 too, so a
      // 403 counts as no access only while whoami still works.
      if (response.status === 403 && mode === "session") await whoami();
      throw new BrightspaceError(statusMessage(response.status), response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new BrightspaceError("Brightspace sent an answer that isn't JSON.");
    }
  }

  async function apiVersions(): Promise<Versions> {
    versions ??= request(new URL("/d2l/api/versions/", origin), "public").then(readVersions);
    try {
      return await versions;
    } catch (error) {
      versions = undefined;
      if (error instanceof SignedOutError) throw error;
      return FALLBACK_VERSIONS;
    }
  }

  async function apiUrl(product: Product, path: string): Promise<URL> {
    const version = (await apiVersions())[product];
    return new URL(`/d2l/api/${product}/${version}/${path}`, origin);
  }

  async function get(product: Product, path: string, mode: "session" | "probe" = "session"): Promise<unknown> {
    return request(await apiUrl(product, path), mode);
  }

  async function pages(product: Product, path: string): Promise<unknown[]> {
    const first = await apiUrl(product, path);
    const objects: unknown[] = [];
    const seen = new Set<string>();
    for (let url: URL | null = first; url && seen.size < MAX_PAGES; ) {
      const page = await request(url);
      if (Array.isArray(page)) return [...objects, ...page];
      const record = obj(page);
      if (!record || !Array.isArray(record.Objects))
        throw new BrightspaceError("Brightspace sent a list in an unexpected shape.");
      objects.push(...record.Objects);
      // Only the bookmark is taken from the Next link; the address is always
      // the first page's, so a Next link can't send the cookie anywhere else.
      const next = str(record.Next);
      const bookmark = next ? new URL(next, url).searchParams.get("bookmark") : null;
      if (!bookmark || seen.has(bookmark)) break;
      seen.add(bookmark);
      url = new URL(first);
      url.searchParams.set("bookmark", bookmark);
    }
    return objects;
  }

  async function enrollmentPages(filter: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let bookmark = "";
    for (let page = 0; page < MAX_ENROLLMENT_PAGES; page += 1) {
      const query = new URLSearchParams(filter);
      if (bookmark) query.set("bookmark", bookmark);
      const data = obj(await get("lp", `enrollments/myenrollments/?${query}`, "probe"));
      items.push(...arr(data?.Items));
      const paging = obj(data?.PagingInfo);
      const mark = paging?.Bookmark;
      const next = str(mark) ?? (num(mark) === null ? null : String(mark));
      if (paging?.HasMoreItems !== true || !next || next === bookmark) break;
      bookmark = next;
    }
    return items;
  }

  async function enrollments(): Promise<unknown[]> {
    // Org unit type 3 is Course Offering on a standard Brightspace. If a
    // school numbers it differently, read every enrollment instead.
    const courses = await enrollmentPages("orgUnitTypeId=3");
    return courses.length > 0 ? courses : enrollmentPages("");
  }

  async function whoami(): Promise<{ id: string; name: string }> {
    const user = obj(await get("lp", "users/whoami", "probe"));
    const id = user?.Identifier;
    if (typeof id !== "string" && typeof id !== "number") throw new SignedOutError();
    const name = [str(user?.FirstName), str(user?.LastName)].filter(Boolean).join(" ");
    return { id: String(id), name: name || str(user?.UniqueName) || String(id) };
  }

  function timeZone(): Promise<string> {
    zone ??= get("lp", "organization/info")
      .then((info) => str(obj(info)?.TimeZone))
      .catch((error: unknown) => {
        if (error instanceof SignedOutError) throw error;
        return null;
      })
      .then((found) => (validTimeZone(found) ? found : Intl.DateTimeFormat().resolvedOptions().timeZone));
    zone.catch(() => {
      zone = undefined;
    });
    return zone;
  }

  return { origin, get: (product, path) => get(product, path), pages, enrollments, whoami, timeZone };
}
