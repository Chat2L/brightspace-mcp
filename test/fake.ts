import type { Fetch } from "../src/brightspace.js";

export const ORIGIN = "https://school.example.edu";

type Answer = { status?: number; type?: string; body?: unknown; location?: string };

/** A fetch that answers by path (and query) and records every request. */
export function fakeFetch(routes: Record<string, Answer | ((url: URL) => Answer)>) {
  const calls: { url: string; cookie: string | null }[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.href, cookie: new Headers(init?.headers).get("cookie") });
    const key = Object.keys(routes).find((route) => url.pathname + url.search === route || url.pathname === route);
    const route = key === undefined ? { status: 404, body: {} } : routes[key];
    const answer = typeof route === "function" ? route(url) : (route ?? { status: 404 });
    const status = answer.status ?? 200;
    const headers = new Headers({ "content-type": answer.type ?? "application/json" });
    if (answer.location) headers.set("location", answer.location);
    const body = status >= 300 && status < 400 ? null : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {});
    return new Response(body, { status, headers });
  };
  return { fetch, calls };
}

export const VERSIONS = {
  "/d2l/api/versions/": {
    body: [
      { ProductCode: "le", LatestVersion: "1.99" },
      { ProductCode: "lp", LatestVersion: "1.63" },
    ],
  },
  "/d2l/api/lp/1.63/organization/info": { body: { TimeZone: "America/Toronto" } },
};
