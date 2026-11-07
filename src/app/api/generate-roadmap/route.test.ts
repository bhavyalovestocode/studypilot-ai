import { beforeEach, describe, expect, it, vi } from "vitest";
import Groq, { APIError } from "groq-sdk";

vi.mock("groq-sdk", async () => {
  const actual = await vi.importActual<typeof import("groq-sdk")>("groq-sdk");
  return { ...actual, default: vi.fn() };
});

const mockedGroq = vi.mocked(Groq);
const DAY = 24 * 60 * 60 * 1000;
const testToday = new Date().toISOString().slice(0, 10);

function dateAfter(days: number) {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

function makeDay(day: number, date = dateAfter(day - 1), subject = "Algebra", idPrefix = `day-${day}`) {
  return {
    day,
    date,
    theoryTopics: [{ id: `${idPrefix}-theory`, title: `Review ${subject} concepts`, subject, estimatedMinutes: 45, completed: false }],
    exercises: [{ id: `${idPrefix}-exercise`, title: `Complete ${subject} exercises`, subject, estimatedMinutes: 30, completed: false }],
    practiceQuestions: [{ id: `${idPrefix}-practice`, title: `Solve ${subject} practice questions`, subject, estimatedMinutes: 30, completed: false }],
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/generate-roadmap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockCompletions(contents: string[]) {
  const create = vi.fn();
  contents.forEach((content) => {
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
  });
  mockedGroq.mockImplementation(
    () =>
      ({
        chat: { completions: { create } },
      }) as unknown as Groq,
  );
  return create;
}

function batchJson(startDay: number, count: number, subject = "Algebra", idPrefix = `batch-${startDay}`) {
  return JSON.stringify({
    roadmap: Array.from({ length: count }, (_, index) =>
      makeDay(startDay + index, dateAfter(startDay + index - 1), subject, `${idPrefix}-${index}`),
    ),
  });
}

describe("POST /api/generate-roadmap", () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = "test-key";
    mockedGroq.mockReset();
  });

  it("returns an empty deterministic roadmap when the exam is today", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: testToday, dailyHours: 3 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ roadmap: [] });
    expect(mockedGroq).not.toHaveBeenCalled();
  });

  it("returns a validated one-day roadmap", async () => {
    mockCompletions([batchJson(1, 1)]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(1), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.roadmap).toHaveLength(1);
    expect(result.roadmap[0].date).toBe(testToday);
    expect(mockedGroq).toHaveBeenCalledWith(expect.objectContaining({ timeout: 30_000, maxRetries: 0 }));
  });

  it("produces exactly six application-scheduled days across bounded provider batches", async () => {
    const create = mockCompletions([batchJson(1, 3), batchJson(4, 3)]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(6), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.roadmap).toHaveLength(6);
    expect(result.roadmap.map((day: { day: number }) => day.day)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.roadmap.map((day: { date: string }) => day.date)).toEqual(
      Array.from({ length: 6 }, (_, index) => dateAfter(index)),
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("produces exactly ten application-scheduled days", async () => {
    mockCompletions([batchJson(1, 3), batchJson(4, 3), batchJson(7, 3), batchJson(10, 1)]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(10), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.roadmap).toHaveLength(10);
    expect(result.roadmap.map((day: { date: string }) => day.date)).toEqual(
      Array.from({ length: 10 }, (_, index) => dateAfter(index)),
    );
  });

  it("cannot truncate a six-day schedule when a later batch is incomplete", async () => {
    mockCompletions([batchJson(1, 3), JSON.stringify({ roadmap: [] })]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(6), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(502);
    expect(result.error).toContain("The AI response was incomplete");
    expect(result.details).toContainEqual(expect.objectContaining({ code: "incomplete-ai-response" }));
    expect(result.details).toContainEqual(expect.objectContaining({ code: "missing-day" }));
  });

  it("rejects duplicate task IDs across provider batches", async () => {
    const duplicate = makeDay(1, dateAfter(0), "Algebra", "same");
    mockCompletions([
      JSON.stringify({ roadmap: [duplicate, makeDay(2, dateAfter(1), "Algebra", "same")] }),
    ]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(2), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(502);
    expect(result.details).toContainEqual(expect.objectContaining({ code: "duplicate-task-id" }));
  });

  it("rejects daily capacity violations", async () => {
    const overloaded = makeDay(1);
    overloaded.theoryTopics[0].estimatedMinutes = 121;
    mockCompletions([JSON.stringify({ roadmap: [overloaded] })]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(1), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(502);
    expect(result.details).toContainEqual(expect.objectContaining({ code: "daily-capacity-exceeded" }));
  });

  it("detects missing syllabus coverage", async () => {
    mockCompletions([batchJson(1, 1, "Algebra")]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra\nGeometry", examDate: dateAfter(1), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(502);
    expect(result.error).toContain("do not cover");
    expect(result.details).toContainEqual(expect.objectContaining({ code: "missing-syllabus-coverage" }));
  });

  it("returns a specific actionable error for invalid AI JSON", async () => {
    mockCompletions(["not valid JSON"]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(1), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(502);
    expect(result.error).toContain("invalid JSON");
    expect(result.details).toContainEqual(expect.objectContaining({ code: "invalid-json" }));
  });

  it("rejects a response with missing task groups", async () => {
    const day = makeDay(1);
    day.exercises = [];
    mockCompletions([JSON.stringify({ roadmap: [day] })]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(1), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(502);
    expect(result.details).toContainEqual(expect.objectContaining({ code: "invalid-task-response" }));
  });

  it("normalizes the provider numeric-key shape without letting it control the date", async () => {
    mockCompletions([JSON.stringify({ 0: makeDay(1, "2099-01-01") })]);
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(1), dailyHours: 3 }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.roadmap[0].date).toBe(testToday);
  });

  it("keeps provider failures safe and actionable", async () => {
    mockedGroq.mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new APIError(500, { message: "private provider detail" }, "provider failed", new Headers()),
              ),
            },
          },
        }) as unknown as Groq,
    );
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: dateAfter(1), dailyHours: 3 }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "The AI provider is temporarily unavailable. Please try again." });
  });
});
