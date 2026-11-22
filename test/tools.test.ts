import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth.js";
import type { openSignIn } from "../src/browser.js";
import { createServer } from "../src/server.js";
import { writeSession } from "../src/session.js";
import { fakeFetch, ORIGIN, VERSIONS } from "./fake.js";

const course = (id: number, name: string, access: object = {}) => ({
  OrgUnit: { Id: id, Name: name, Code: `C${id}`, Type: { Id: 3, Name: "Course Offering" } },
  Access: { IsActive: true, CanAccess: true, ...access },
});

const ENROLLMENTS = {
  "/d2l/api/lp/1.63/enrollments/myenrollments/": {
    body: {
      Items: [
        course(1, "Operations"),
        course(2, "Old course", { EndDate: "2020-01-01T00:00:00.000Z" }),
        { OrgUnit: { Id: 9, Name: "Commerce", Type: { Id: 2, Name: "Department" } }, Access: {} },
      ],
      PagingInfo: { HasMoreItems: false },
    },
  },
};

async function connect(fetch: ReturnType<typeof fakeFetch>["fetch"], { signedIn = true, open }: { signedIn?: boolean; open?: typeof openSignIn } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "d2l-mcp-"));
  await writeSession(dir, { origin: ORIGIN, cookies: signedIn ? [{ name: "d2lSessionVal", value: "abc" }] : [], user: null });
  const auth = createAuth({ dir, fetch, browser: () => ({ name: "Chrome", path: "/fake/chrome" }), ...(open ? { open } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(auth).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = content && typeof content === "object" && "text" in content && typeof content.text === "string" ? content.text : "";
    return { isError: result.isError === true, text };
  };
}

describe("tools", () => {
  it("lists only current courses unless past ones are asked for", async () => {
    const call = await connect(fakeFetch({ ...VERSIONS, ...ENROLLMENTS }).fetch);
    expect(JSON.parse((await call("list_courses")).text).map((c: { id: number }) => c.id)).toEqual([1]);
    expect(JSON.parse((await call("list_courses", { include_past: true })).text).map((c: { id: number }) => c.id)).toEqual([1, 2]);
  });

  it("opens one sign-in window when the session has expired, and says so", async () => {
    const open = vi.fn<typeof openSignIn>(async () => ({ finished: new Promise(() => {}) }));
    const call = await connect(fakeFetch({ ...VERSIONS, "/d2l/api/lp/1.63/enrollments/myenrollments/": { status: 403 } }).fetch, { open });
    const first = await call("list_courses");
    expect(first).toMatchObject({ isError: true });
    expect(first.text).toContain("just opened in Chrome");
    expect((await call("list_courses")).text).toContain("already open");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens a single window when several tools find the session expired at once", async () => {
    const open = vi.fn<typeof openSignIn>(async () => ({ finished: new Promise(() => {}) }));
    const call = await connect(fakeFetch({ ...VERSIONS, "/d2l/api/lp/1.63/enrollments/myenrollments/": { status: 403 } }).fetch, { open });
    const answers = await Promise.all([call("list_courses"), call("list_upcoming"), call("list_announcements")]);
    expect(answers.every((answer) => answer.isError && answer.text.includes("just opened in Chrome"))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("asks for setup rather than opening a window when no school is known", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d2l-mcp-"));
    const open = vi.fn<typeof openSignIn>();
    const auth = createAuth({ dir, open });
    await expect(auth.brightspace()).rejects.toMatchObject({ name: "NotSetUpError" });
    expect(await auth.signedOut()).toContain("npx d2l-mcp login");
    expect(open).not.toHaveBeenCalled();
  });

  it("lists upcoming items by kind and keeps repeating events apart", async () => {
    const event = (title: string, start: string, extra: object = {}) => ({
      Title: title, OrgUnitId: 1, StartDateTime: start, EndDateTime: start, IsAllDayEvent: false, IsRecurring: false, ...extra,
    });
    const { fetch } = fakeFetch({
      ...VERSIONS,
      ...ENROLLMENTS,
      "/d2l/api/le/1.99/calendar/events/myEvents/": (url) => {
        expect(url.searchParams.get("orgUnitIdsCSV")).toBe("1");
        return {
          body: {
            Objects: [
              event("Case report", "2099-11-24T04:59:00.000Z", { EventType: 6, Description: "<p>Upload the <b>deck</b> &amp; video</p>" }),
              event("Drop-in hours", "2020-09-22T17:30:00.000Z", { IsRecurring: true, RecurrenceInfo: { RepeatOnInfo: { Tuesday: true }, RepeatUntilDate: "2099-12-08T00:00:00.000Z" } }),
            ],
            Next: null,
          },
        };
      },
    });
    const result = JSON.parse((await (await connect(fetch))("list_upcoming")).text);
    expect(result.events).toEqual([
      { when: "Mon, Nov 23, 2099, 11:59 PM EST", kind: "due", course: "Operations", title: "Case report", details: "Upload the deck & video" },
    ]);
    expect(result.repeating).toMatchObject([{ title: "Drop-in hours", repeatsOn: "Tuesday" }]);
  });

  it("outlines course content with nested modules and topic links", async () => {
    const { fetch } = fakeFetch({
      ...VERSIONS,
      "/d2l/api/le/1.99/1/content/toc": {
        body: {
          Modules: [
            {
              Title: "Week 1",
              Topics: [{ TopicId: 11, Title: "Lecture 1", TypeIdentifier: "File", Url: "/content/enforced/1/lecture1.PDF" }],
              Modules: [{ Title: "Readings", Topics: [{ TopicId: 12, Title: "Chapter 1", TypeIdentifier: "Link" }], Modules: [] }],
            },
          ],
        },
      },
    });
    expect((await (await connect(fetch))("get_course_content", { course_id: 1 })).text).toBe(
      [
        "[Week 1]",
        `  - Lecture 1 (pdf file) ${ORIGIN}/d2l/le/content/1/viewContent/11/View`,
        "  [Readings]",
        `    - Chapter 1 (link) ${ORIGIN}/d2l/le/content/1/viewContent/12/View`,
      ].join("\n"),
    );
  });
});
