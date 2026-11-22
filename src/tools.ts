// The MCP tools: read-only views of one student's Brightspace.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Auth, NotSetUpError } from "./auth.js";
import { type Brightspace, BrightspaceError, SignedOutError } from "./brightspace.js";
import { arr, clip, mapLimit, num, obj, type Obj, plain, str } from "./values.js";

const LANES = 4;
const MAX_TOPICS = 500;
const MAX_ASSIGNMENTS = 40;

export interface Course {
  id: number;
  name: string;
  code: string | null;
  active: boolean;
  pinned: boolean;
  start: string | null;
  end: string | null;
}

/** A date as the student sees it in Brightspace, e.g. "Tue, Nov 24, 2026, 11:59 PM EST". */
export function formatDate(value: unknown, timeZone: string, dateOnly = false): string | null {
  const text = str(value);
  const date = text ? new Date(text) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
  }).format(date);
}

const time = (value: unknown) => {
  const parsed = Date.parse(str(value) ?? "");
  return Number.isNaN(parsed) ? null : parsed;
};

export async function listCourses(bs: Brightspace, now = Date.now()): Promise<Course[]> {
  const courses: Course[] = [];
  for (const value of await bs.enrollments()) {
    const item = obj(value);
    const unit = obj(item?.OrgUnit);
    const id = num(unit?.Id);
    const type = obj(unit?.Type);
    if (id === null || (num(type?.Id) !== 3 && str(type?.Name) !== "Course Offering")) continue;
    const access = obj(item?.Access);
    const end = time(access?.EndDate);
    courses.push({
      id,
      name: str(unit?.Name) ?? `Course ${id}`,
      code: str(unit?.Code),
      active: access?.IsActive !== false && access?.CanAccess !== false && !(end !== null && end < now),
      pinned: Boolean(item?.PinDate),
      start: str(access?.StartDate),
      end: str(access?.EndDate),
    });
  }
  return courses.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.pinned) - Number(a.pinned));
}

async function activeCourses(bs: Brightspace): Promise<Course[]> {
  return (await listCourses(bs)).filter((course) => course.active);
}

/** Runs `read` for each course; a course that fails is named, not fatal. */
async function eachCourse<T>(courses: Course[], read: (course: Course) => Promise<T[]>) {
  const skipped: string[] = [];
  const found = await mapLimit(courses, LANES, async (course) => {
    try {
      return await read(course);
    } catch (error) {
      if (error instanceof SignedOutError) throw error;
      skipped.push(course.name);
      return [];
    }
  });
  return { items: found.flat(), skipped };
}

function topicKind(topic: Obj): string {
  const type = str(topic.TypeIdentifier) ?? "Topic";
  const extension = /\.([a-z\d]{1,5})$/i.exec(str(topic.Url)?.split("?")[0] ?? "")?.[1];
  return type === "File" && extension ? `${extension.toLowerCase()} file` : type.toLowerCase();
}

export function contentOutline(toc: unknown, origin: string, courseId: number, timeZone: string): string {
  const lines: string[] = [];
  let topics = 0;
  const walk = (modules: unknown[], depth: number) => {
    for (const value of modules) {
      const module = obj(value);
      if (!module || topics >= MAX_TOPICS) continue;
      lines.push(`${"  ".repeat(depth)}[${str(module.Title) ?? "Untitled module"}]`);
      for (const topicValue of arr(module.Topics)) {
        const topic = obj(topicValue);
        if (!topic || topics >= MAX_TOPICS) continue;
        topics += 1;
        const id = num(topic.TopicId) ?? num(topic.Identifier);
        const due = formatDate(topic.DueDate, timeZone);
        const link = id === null ? "" : ` ${origin}/d2l/le/content/${courseId}/viewContent/${id}/View`;
        lines.push(
          `${"  ".repeat(depth + 1)}- ${str(topic.Title) ?? "Untitled"} (${topicKind(topic)}${due ? `, due ${due}` : ""})${link}`,
        );
      }
      walk(arr(module.Modules), depth + 1);
    }
  };
  walk(arr(obj(toc)?.Modules), 0);
  if (lines.length === 0) return "This course has no content the student can see.";
  if (topics >= MAX_TOPICS) lines.push(`(Stopped after ${MAX_TOPICS} items.)`);
  return lines.join("\n");
}

// ENTITYDROPBOXSTATUS_T
const SUBMISSION_STATUS: Record<number, string> = {
  0: "not submitted",
  1: "submitted",
  2: "draft saved, not submitted",
  3: "graded, feedback published",
};

function submissionSummary(data: unknown, timeZone: string) {
  const entity = obj(arr(data)[0]);
  if (!entity) return { status: "not submitted" };
  const files = arr(entity.Submissions).map(obj);
  const latest = files
    .map((file) => str(file?.SubmissionDate))
    .filter((date): date is string => date !== null)
    .sort()
    .at(-1);
  const feedback = obj(entity.Feedback);
  const score = num(feedback?.Score);
  const status = num(entity.Status);
  return {
    status: (status !== null ? SUBMISSION_STATUS[status] : undefined) ?? (files.length > 0 ? "submitted" : "not submitted"),
    submitted: formatDate(latest, timeZone),
    files: files.length || undefined,
    score: score ?? undefined,
    feedback: clip(obj(feedback?.Feedback)?.Text, 800) ?? undefined,
  };
}

async function assignments(bs: Brightspace, courseId: number) {
  const timeZone = await bs.timeZone();
  const folders = arr(await bs.get("le", `${courseId}/dropbox/folders/`))
    .map(obj)
    .filter((folder): folder is Obj => folder !== null)
    .sort((a, b) => (time(a.DueDate) ?? Infinity) - (time(b.DueDate) ?? Infinity))
    .slice(0, MAX_ASSIGNMENTS);
  return mapLimit(folders, LANES, async (folder) => {
    const id = num(folder.Id);
    let submission: ReturnType<typeof submissionSummary> | { status: string } = { status: "unknown" };
    if (id !== null) {
      try {
        submission = submissionSummary(
          await bs.get("le", `${courseId}/dropbox/folders/${id}/submissions/mysubmissions/`),
          timeZone,
        );
      } catch (error) {
        if (error instanceof SignedOutError) throw error;
      }
    }
    const availability = obj(folder.Availability);
    return {
      id,
      name: str(folder.Name) ?? `Assignment ${id ?? ""}`.trim(),
      due: formatDate(folder.DueDate, timeZone),
      opens: formatDate(availability?.StartDate, timeZone) ?? undefined,
      closes: formatDate(availability?.EndDate, timeZone) ?? undefined,
      outOf: num(obj(folder.Assessment)?.ScoreDenominator) ?? undefined,
      instructions: clip(obj(folder.CustomInstructions)?.Text, 1_000) ?? undefined,
      ...submission,
    };
  });
}

async function announcements(bs: Brightspace, courseId: number | undefined, limit: number) {
  const timeZone = await bs.timeZone();
  const all = await listCourses(bs);
  const courses = courseId === undefined ? all.filter((course) => course.active) : [findCourse(all, courseId)];
  const { items, skipped } = await eachCourse(courses, async (course) =>
    arr(await bs.get("le", `${course.id}/news/`))
      .map(obj)
      .filter((item): item is Obj => item !== null && item.IsPublished !== false)
      .map((item) => ({ course: course.name, item })),
  );
  const sorted = items
    .sort((a, b) => (time(b.item.StartDate) ?? 0) - (time(a.item.StartDate) ?? 0))
    .slice(0, limit)
    .map(({ course, item }) => ({
      course,
      title: str(item.Title) ?? "Untitled",
      posted: formatDate(item.StartDate, timeZone),
      pinned: item.IsPinned === true || undefined,
      text: clip(obj(item.Body)?.Text, 1_500) ?? "",
    }));
  return { announcements: sorted, ...(skipped.length ? { couldNotRead: skipped } : {}) };
}

// Calendar EventType values as Brightspace sends them.
const EVENT_KINDS: Record<number, string> = { 1: "event", 2: "opens", 3: "closes", 6: "due" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function upcoming(bs: Brightspace, days: number, courseId: number | undefined, now = Date.now()) {
  const timeZone = await bs.timeZone();
  const all = await listCourses(bs, now);
  const courses = courseId === undefined ? all.filter((course) => course.active) : [findCourse(all, courseId)];
  if (courses.length === 0) return { events: [], note: "No active courses." };
  const names = new Map(courses.map((course) => [course.id, course.name]));
  const from = new Date(now).toISOString();
  const query = new URLSearchParams({
    orgUnitIdsCSV: courses.map((course) => course.id).join(","),
    startDateTime: from,
    endDateTime: new Date(now + days * 86_400_000).toISOString(),
  });
  const found = (await bs.pages("le", `calendar/events/myEvents/?${query}`))
    .map(obj)
    .filter((event): event is Obj => event !== null)
    .sort((a, b) => (time(a.StartDateTime) ?? 0) - (time(b.StartDateTime) ?? 0));
  const course = (event: Obj) => {
    const unit = num(event.OrgUnitId);
    return (unit !== null ? names.get(unit) : undefined) ?? str(event.OrgUnitName) ?? undefined;
  };
  const events = [];
  const repeating = [];
  for (const event of found) {
    const allDay = event.IsAllDayEvent === true;
    const start = formatDate(event.StartDateTime, timeZone, allDay);
    const end = formatDate(event.EndDateTime, timeZone, allDay);
    const details = clip(plain(event.Description), 300) ?? undefined;
    // A repeating event comes back once, with the date it first happened.
    if (event.IsRecurring === true) {
      const recurrence = obj(event.RecurrenceInfo);
      const on = obj(recurrence?.RepeatOnInfo);
      repeating.push({
        course: course(event),
        title: str(event.Title) ?? "Untitled",
        firstTime: end && end !== start ? `${start} to ${end}` : start,
        repeatsOn: WEEKDAYS.filter((day) => on?.[day] === true).join(", ") || undefined,
        until: formatDate(recurrence?.RepeatUntilDate, timeZone, true) ?? undefined,
        details,
      });
      continue;
    }
    const type = num(event.EventType);
    events.push({
      when: end && end !== start ? `${start} to ${end}` : start,
      kind: (type !== null ? EVENT_KINDS[type] : undefined) ?? "event",
      course: course(event),
      title: str(event.Title) ?? "Untitled",
      details,
    });
  }
  return { from: formatDate(from, timeZone), days, events, ...(repeating.length ? { repeating } : {}) };
}

async function optional(read: () => Promise<unknown>): Promise<unknown[]> {
  try {
    return arr(await read());
  } catch (error) {
    if (error instanceof SignedOutError) throw error;
    return [];
  }
}

async function grades(bs: Brightspace, courseId: number) {
  const [values, items, categories] = await Promise.all([
    bs.get("le", `${courseId}/grades/values/myGradeValues/`).then(arr),
    optional(() => bs.get("le", `${courseId}/grades/`)),
    optional(() => bs.get("le", `${courseId}/grades/categories/`)),
  ]);
  const categoryNames = new Map<number, string>();
  const categoryList = categories.flatMap((value) => {
    const category = obj(value);
    const id = num(category?.Id);
    const name = str(category?.Name);
    if (!category || id === null || !name) return [];
    categoryNames.set(id, name);
    return [
      {
        name,
        weight: num(category.Weight) ?? undefined,
        dropsLowest: num(category.NumberOfLowestToDrop) || undefined,
      },
    ];
  });
  const byId = new Map<string, Obj>();
  for (const value of values) {
    const grade = obj(value);
    const id = str(grade?.GradeObjectIdentifier) ?? String(num(grade?.GradeObjectIdentifier) ?? "");
    if (grade && id) byId.set(id, grade);
  }
  const seen = new Set<string>();
  const rows = items.flatMap((value) => {
    const item = obj(value);
    const id = num(item?.Id);
    if (!item || id === null) return [];
    seen.add(String(id));
    const grade = byId.get(String(id));
    const category = num(item.CategoryId);
    return [gradeRow(str(item.Name), grade, num(item.MaxPoints), num(item.Weight), category ? categoryNames.get(category) : undefined)];
  });
  for (const [id, grade] of byId)
    if (!seen.has(id)) rows.push(gradeRow(str(grade.GradeObjectName), grade, null, null, undefined));
  return { grades: rows, ...(categoryList.length ? { categories: categoryList } : {}) };
}

function gradeRow(name: string | null, grade: Obj | undefined, maxPoints: number | null, weight: number | null, category: string | undefined) {
  const points = num(grade?.PointsNumerator);
  const outOf = num(grade?.PointsDenominator) ?? maxPoints;
  return {
    name: name ?? str(grade?.GradeObjectName) ?? "Untitled",
    category,
    grade: str(grade?.DisplayedGrade) ?? (points !== null && outOf ? `${points} / ${outOf}` : "not graded yet"),
    points: points ?? undefined,
    outOf: outOf ?? undefined,
    weight: weight || undefined,
    weightedPoints: num(grade?.WeightedNumerator) ?? undefined,
    weightedOutOf: num(grade?.WeightedDenominator) ?? undefined,
    comments: clip(obj(grade?.Comments)?.Text, 500) ?? undefined,
  };
}

async function quizzes(bs: Brightspace, courseId: number) {
  const timeZone = await bs.timeZone();
  return (await bs.pages("le", `${courseId}/quizzes/`))
    .map(obj)
    .filter((quiz): quiz is Obj => quiz !== null && quiz.IsActive !== false)
    .map((quiz) => {
      const limit = obj(quiz.TimeLimit);
      const attempts = obj(quiz.AttemptsAllowed);
      return {
        id: num(quiz.QuizId),
        name: str(quiz.Name) ?? "Untitled quiz",
        due: formatDate(quiz.DueDate, timeZone),
        opens: formatDate(quiz.StartDate, timeZone) ?? undefined,
        closes: formatDate(quiz.EndDate, timeZone) ?? undefined,
        timeLimitMinutes: limit?.IsEnforced === true ? (num(limit.TimeLimitValue) ?? undefined) : undefined,
        attempts: attempts?.IsUnlimited === true ? "unlimited" : (num(attempts?.NumberOfAttemptsAllowed) ?? undefined),
        description: clip(obj(obj(quiz.Description)?.Text)?.Text, 300) ?? undefined,
      };
    });
}

function findCourse(courses: Course[], id: number): Course {
  const course = courses.find((candidate) => candidate.id === id);
  if (!course) throw new BrightspaceError(`No course with id ${id}. Call list_courses for the ids.`);
  return course;
}

const courseId = z.number().int().positive().describe("The course id from list_courses.");

export function registerTools(server: McpServer, auth: Auth): void {
  const run = async (read: (bs: Brightspace) => Promise<unknown>): Promise<CallToolResult> => {
    try {
      const result = await read(await auth.brightspace());
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      let text: string;
      if (error instanceof SignedOutError) text = await auth.signedOut();
      else if (error instanceof NotSetUpError || error instanceof BrightspaceError) text = error.message;
      else {
        console.error("d2l-mcp:", error);
        text = "Something went wrong reading Brightspace. Try again.";
      }
      return { isError: true, content: [{ type: "text", text }] };
    }
  };
  const annotations = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description: "The student's Brightspace courses with ids, codes and term dates. Call this first to get course ids.",
      inputSchema: { include_past: z.boolean().optional().describe("Also list past and inactive courses. Default false.") },
      annotations,
    },
    ({ include_past }) =>
      run(async (bs) => {
        const timeZone = await bs.timeZone();
        const courses = await listCourses(bs);
        return courses
          .filter((course) => include_past || course.active)
          .map(({ start, end, pinned, ...course }) => ({
            ...course,
            pinned: pinned || undefined,
            starts: formatDate(start, timeZone, true) ?? undefined,
            ends: formatDate(end, timeZone, true) ?? undefined,
          }));
      }),
  );

  server.registerTool(
    "get_course_content",
    {
      title: "Get course content",
      description:
        "A course's modules and topics (lecture files, readings, links, quizzes) as an outline with due dates and links. " +
        "It lists files but does not read what is inside them.",
      inputSchema: { course_id: courseId },
      annotations,
    },
    ({ course_id }) =>
      run(async (bs) => contentOutline(await bs.get("le", `${course_id}/content/toc`), bs.origin, course_id, await bs.timeZone())),
  );

  server.registerTool(
    "list_assignments",
    {
      title: "List assignments",
      description:
        "A course's assignments (dropbox folders) with due dates, instructions, and the student's own submission status, score and feedback.",
      inputSchema: { course_id: courseId },
      annotations,
    },
    ({ course_id }) => run((bs) => assignments(bs, course_id)),
  );

  server.registerTool(
    "list_announcements",
    {
      title: "List announcements",
      description: "Recent announcements, newest first, from one course or from every active course.",
      inputSchema: {
        course_id: courseId.optional().describe("One course id from list_courses. Leave out for every active course."),
        limit: z.number().int().min(1).max(50).optional().describe("How many to return. Default 10."),
      },
      annotations,
    },
    ({ course_id, limit }) => run((bs) => announcements(bs, course_id, limit ?? 10)),
  );

  server.registerTool(
    "list_upcoming",
    {
      title: "List upcoming",
      description:
        "Upcoming due dates, quizzes, exams and class events from the Brightspace calendar across every active course, soonest first.",
      inputSchema: {
        days: z.number().int().min(1).max(180).optional().describe("How many days ahead to look. Default 14."),
        course_id: courseId.optional().describe("Only this course. Leave out for every active course."),
      },
      annotations,
    },
    ({ days, course_id }) => run((bs) => upcoming(bs, days ?? 14, course_id)),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get grades",
      description: "The student's grades in a course: each grade item, points, weight and comments, plus category weights.",
      inputSchema: { course_id: courseId },
      annotations,
    },
    ({ course_id }) => run((bs) => grades(bs, course_id)),
  );

  server.registerTool(
    "list_quizzes",
    {
      title: "List quizzes",
      description: "A course's quizzes with open, due and close dates, time limits and attempts allowed.",
      inputSchema: { course_id: courseId },
      annotations,
    },
    ({ course_id }) => run((bs) => quizzes(bs, course_id)),
  );
}
