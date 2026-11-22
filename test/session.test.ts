import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { schoolCookies } from "../src/browser.js";
import { parseCookieHeader, readSession, schoolOrigin, writeSession } from "../src/session.js";

describe("school address", () => {
  it.each([
    ["school.brightspace.com", "https://school.brightspace.com"],
    ["https://onq.queensu.ca/d2l/home", "https://onq.queensu.ca"],
    [" learn.example.edu/ ", "https://learn.example.edu"],
  ])("reads %s", (input, origin) => expect(schoolOrigin(input)).toBe(origin));

  it.each(["http://school.example.edu", "https://me:pw@school.example.edu", "", "not a host!"])("refuses %j", (input) =>
    expect(() => schoolOrigin(input)).toThrow(),
  );
});

describe("saved session", () => {
  it("is readable only by the current user and reads back", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "d2l-mcp-")), "home");
    await writeSession(dir, { origin: "https://school.example.edu", cookies: [{ name: "a", value: "1" }], user: "Sam" });
    expect((await stat(join(dir, "session.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readSession(dir)).toMatchObject({ origin: "https://school.example.edu", user: "Sam", cookies: [{ name: "a", value: "1" }] });
  });

  it("treats a missing or damaged file as no session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d2l-mcp-"));
    expect(await readSession(dir)).toBeNull();
    await writeFile(join(dir, "session.json"), "{not json");
    expect(await readSession(dir)).toBeNull();
  });

  it("parses a pasted Cookie header", () => {
    expect(parseCookieHeader("d2lSessionVal=a; d2lSecureSessionVal=b=c")).toEqual([
      { name: "d2lSessionVal", value: "a" },
      { name: "d2lSecureSessionVal", value: "b=c" },
    ]);
    expect(() => parseCookieHeader("nothing here")).toThrow();
  });
});

describe("cookies taken from the sign-in window", () => {
  it("keeps only cookies the school's API would receive", () => {
    const cookie = (name: string, domain: string, path = "/") => ({ name, value: "v", domain, path });
    expect(
      schoolCookies(
        [
          cookie("d2lSessionVal", "learn.example.edu"),
          cookie("", "learn.example.edu"),
          cookie("parent", ".example.edu", "/d2l"),
          cookie("idp", "login.microsoftonline.com"),
          cookie("lookalike", "notexample.edu"),
          cookie("other-path", "learn.example.edu", "/content"),
        ],
        "https://learn.example.edu",
      ).map((c) => c.name),
    ).toEqual(["d2lSessionVal", "parent"]);
  });
});
