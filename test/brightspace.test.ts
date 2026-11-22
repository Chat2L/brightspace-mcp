import { describe, expect, it } from "vitest";
import { BrightspaceError, createBrightspace, SignedOutError } from "../src/brightspace.js";
import { fakeFetch, ORIGIN, VERSIONS } from "./fake.js";

const cookies = [{ name: "d2lSessionVal", value: "abc" }];

describe("Brightspace client", () => {
  it("calls the school's latest API versions with the session cookie", async () => {
    const { fetch, calls } = fakeFetch({ ...VERSIONS, "/d2l/api/le/1.99/5/news/": { body: [] } });
    await createBrightspace({ origin: ORIGIN, cookies, fetch }).get("le", "5/news/");
    expect(calls.at(-1)).toEqual({ url: `${ORIGIN}/d2l/api/le/1.99/5/news/`, cookie: "d2lSessionVal=abc" });
  });

  it.each([
    ["a redirect to the sign-in page", { status: 302, location: "/d2l/login" }],
    ["a 401", { status: 401 }],
    ["an HTML sign-in page", { type: "text/html", body: "<html>Sign in</html>" }],
  ])("treats %s as signed out", async (_, answer) => {
    const { fetch } = fakeFetch({ ...VERSIONS, "/d2l/api/le/1.99/5/news/": answer });
    await expect(createBrightspace({ origin: ORIGIN, cookies, fetch }).get("le", "5/news/")).rejects.toBeInstanceOf(SignedOutError);
  });

  it("reads a course 403 as no access while signed in, and as signed out once whoami fails too", async () => {
    const whoami = { body: { Identifier: "7", FirstName: "Sam" } };
    const signedIn = fakeFetch({ ...VERSIONS, "/d2l/api/lp/1.63/users/whoami": whoami, "/d2l/api/le/1.99/5/grades/": { status: 403 } });
    await expect(createBrightspace({ origin: ORIGIN, cookies, fetch: signedIn.fetch }).get("le", "5/grades/")).rejects.toMatchObject({
      name: "BrightspaceError",
      status: 403,
    });
    const expired = fakeFetch({ ...VERSIONS, "/d2l/api/lp/1.63/users/whoami": { status: 403 }, "/d2l/api/le/1.99/5/grades/": { status: 403 } });
    await expect(createBrightspace({ origin: ORIGIN, cookies, fetch: expired.fetch }).get("le", "5/grades/")).rejects.toBeInstanceOf(SignedOutError);
  });

  it("asks for the version list without the cookie, so an expired cookie can't block it", async () => {
    const { fetch, calls } = fakeFetch({
      ...VERSIONS,
      "/d2l/api/lp/1.63/users/whoami": { status: 403 },
      "/d2l/api/le/1.99/5/grades/": { status: 403 },
    });
    await expect(createBrightspace({ origin: ORIGIN, cookies, fetch }).get("le", "5/grades/")).rejects.toBeInstanceOf(SignedOutError);
    expect(calls.find((call) => call.url.endsWith("/d2l/api/versions/"))?.cookie).toBeNull();
  });

  it("takes only the bookmark from a Next link, so the cookie never goes to another site", async () => {
    const { fetch, calls } = fakeFetch({
      ...VERSIONS,
      "/d2l/api/le/1.99/5/quizzes/?bookmark=2": { body: { Objects: [{ QuizId: 2 }], Next: null } },
      "/d2l/api/le/1.99/5/quizzes/": { body: { Objects: [{ QuizId: 1 }], Next: "https://evil.example.com/steal/?bookmark=2" } },
    });
    expect(await createBrightspace({ origin: ORIGIN, cookies, fetch }).pages("le", "5/quizzes/")).toEqual([{ QuizId: 1 }, { QuizId: 2 }]);
    expect(calls.map((call) => call.url).filter((url) => url.includes("quizzes"))).toEqual([
      `${ORIGIN}/d2l/api/le/1.99/5/quizzes/`,
      `${ORIGIN}/d2l/api/le/1.99/5/quizzes/?bookmark=2`,
    ]);
  });

  it("collects enrollments across bookmark pages", async () => {
    const { fetch } = fakeFetch({
      ...VERSIONS,
      "/d2l/api/lp/1.63/enrollments/myenrollments/?orgUnitTypeId=3&bookmark=b1": { body: { Items: [{ n: 2 }], PagingInfo: { Bookmark: "b2", HasMoreItems: false } } },
      "/d2l/api/lp/1.63/enrollments/myenrollments/?orgUnitTypeId=3": { body: { Items: [{ n: 1 }], PagingInfo: { Bookmark: "b1", HasMoreItems: true } } },
    });
    expect(await createBrightspace({ origin: ORIGIN, cookies, fetch }).enrollments()).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
