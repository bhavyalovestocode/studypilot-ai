import { beforeEach, describe, expect, it, vi } from "vitest";
import Groq, { APIError } from "groq-sdk";

vi.mock("groq-sdk", async () => {
  const actual = await vi.importActual<typeof import("groq-sdk")>("groq-sdk");
  return { ...actual, default: vi.fn() };
});

const mockedGroq = vi.mocked(Groq);
const validRoadmap = {
  roadmap: [
    {
      day: 1,
      date: "2026-10-09",
      topics: [
        {
          id: "algebra-1",
          title: "Linear equations",
          subject: "Algebra",
          estimatedMinutes: 60,
          completed: false,
        },
      ],
    },
  ],
};

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/generate-roadmap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockCompletion(content: string) {
  mockedGroq.mockImplementation(
    () =>
      ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content } }],
            }),
          },
        },
      }) as unknown as Groq,
  );
}

describe("POST /api/generate-roadmap", () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = "test-key";
    mockedGroq.mockReset();
  });

  it("returns 500 when the API key is missing", async () => {
    delete process.env.GROQ_API_KEY;
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: "2026-10-20", dailyHours: 3 }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "GROQ_API_KEY is not configured." });
  });

  it("rejects invalid input", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ syllabusText: "", examDate: "not-a-date", dailyHours: 20 }));

    expect(response.status).toBe(400);
  });

  it("returns a validated roadmap on successful generation", async () => {
    mockCompletion(JSON.stringify(validRoadmap));
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: "2026-10-20", dailyHours: 3 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(validRoadmap);
    expect(mockedGroq).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 30_000, maxRetries: 0 }),
    );
  });

  it("returns a safe error when the provider fails", async () => {
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

    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: "2026-10-20", dailyHours: 3 }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The AI service could not generate a roadmap right now.",
    });
  });

  it("rejects malformed AI output", async () => {
    mockCompletion("not valid JSON");
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ syllabusText: "Algebra", examDate: "2026-10-20", dailyHours: 3 }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Groq returned invalid JSON." });
  });
});
