import Groq, {
  APIConnectionTimeoutError,
  APIError,
  RateLimitError,
} from "groq-sdk";
import { NextResponse } from "next/server";

const MODEL = "openai/gpt-oss-20b";
const MIN_DAILY_HOURS = 1;
const MAX_DAILY_HOURS = 12;
const PROVIDER_TIMEOUT_MS = 30_000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface RoadmapTopic {
  id: string;
  title: string;
  subject: string;
  estimatedMinutes: number;
  completed: boolean;
}

interface RoadmapDay {
  day: number;
  date: string;
  topics: RoadmapTopic[];
}

interface RoadmapResponse {
  roadmap: RoadmapDay[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRoadmapResponse(value: unknown): value is RoadmapResponse {
  if (!isRecord(value) || !Array.isArray(value.roadmap)) {
    return false;
  }

  return value.roadmap.every((day) => {
    if (
      !isRecord(day) ||
      typeof day.day !== "number" ||
      typeof day.date !== "string" ||
      !Array.isArray(day.topics)
    ) {
      return false;
    }

    return day.topics.every((topic) => {
      if (
        !isRecord(topic) ||
        typeof topic.id !== "string" ||
        typeof topic.title !== "string" ||
        typeof topic.subject !== "string" ||
        typeof topic.estimatedMinutes !== "number" ||
        !Number.isFinite(topic.estimatedMinutes) ||
        topic.estimatedMinutes < 0 ||
        typeof topic.completed !== "boolean"
      ) {
        return false;
      }

      return true;
    });
  });
}

function getUtcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!isRecord(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  const { syllabusText, examDate, dailyHours } = body;

  if (
    typeof syllabusText !== "string" ||
    syllabusText.trim().length === 0 ||
    typeof examDate !== "string" ||
    examDate.trim().length === 0 ||
    typeof dailyHours !== "number" ||
    !Number.isFinite(dailyHours) ||
    dailyHours < MIN_DAILY_HOURS ||
    dailyHours > MAX_DAILY_HOURS
  ) {
    return NextResponse.json(
      {
        error:
          `syllabusText and examDate must be non-empty strings, and dailyHours must be a finite number from ${MIN_DAILY_HOURS} to ${MAX_DAILY_HOURS}.`,
      },
      { status: 400 },
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
    return NextResponse.json({ error: "examDate must use the YYYY-MM-DD format." }, { status: 400 });
  }

  const parsedExamDate = new Date(examDate);
  if (
    Number.isNaN(parsedExamDate.getTime()) ||
    parsedExamDate.toISOString().slice(0, 10) !== examDate
  ) {
    return NextResponse.json({ error: "examDate must be a valid date." }, { status: 400 });
  }

  const today = getUtcDate(new Date());
  const examDay = getUtcDate(parsedExamDate);
  const daysRemaining = Math.ceil(
    (examDay.getTime() - today.getTime()) / MILLISECONDS_PER_DAY,
  );

  if (daysRemaining < 0) {
    return NextResponse.json({ error: "examDate must be today or in the future." }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is missing; roadmap generation is unavailable.");
    return NextResponse.json({ error: "GROQ_API_KEY is not configured." }, { status: 500 });
  }

  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    maxRetries: 0,
    timeout: PROVIDER_TIMEOUT_MS,
  });
  const todayString = today.toISOString().slice(0, 10);
  const examDayString = examDay.toISOString().slice(0, 10);

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You create practical study roadmaps. Return only valid JSON matching the requested schema. Do not include markdown, explanations, or additional properties.",
        },
        {
          role: "user",
          content: `Parse the syllabus below into a structured daily study plan.

Today is ${todayString}. The exam is on ${examDayString}. There are ${daysRemaining} days remaining, and the student can study ${dailyHours} hours per day.

Return STRICT JSON with exactly this shape:
{
  "roadmap": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "topics": [
        {
          "id": "unique-string",
          "title": "Topic title",
          "subject": "Subject name",
          "estimatedMinutes": 60,
          "completed": false
        }
      ]
    }
  ]
}

Create one roadmap entry for each study day from today through the day before the exam. Use at most ${dailyHours * 60} total estimated minutes per day. Set every completed value to false. Use unique topic IDs. If there are no study days, return {"roadmap":[]}.

Syllabus:
${syllabusText.trim()}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string") {
      return NextResponse.json({ error: "Groq returned an empty response." }, { status: 502 });
    }

    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(content);
    } catch {
      return NextResponse.json({ error: "Groq returned invalid JSON." }, { status: 502 });
    }

    if (!isRoadmapResponse(parsedResponse)) {
      return NextResponse.json(
        { error: "Groq returned JSON that does not match the roadmap schema." },
        { status: 502 },
      );
    }

    return NextResponse.json(parsedResponse);
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.error("Groq rate limit reached while generating roadmap.", {
        status: error.status,
      });
      return NextResponse.json(
        { error: "The AI service is busy. Please wait a moment and try again." },
        { status: 429 },
      );
    }

    if (error instanceof APIConnectionTimeoutError) {
      console.error("Groq request timed out while generating roadmap.", {
        timeoutMs: PROVIDER_TIMEOUT_MS,
      });
      return NextResponse.json(
        { error: "The AI service took too long to respond. Please try again." },
        { status: 504 },
      );
    }

    if (error instanceof APIError) {
      console.error("Groq rejected the roadmap request.", { status: error.status });
      return NextResponse.json(
        { error: "The AI service could not generate a roadmap right now." },
        { status: 502 },
      );
    }

    console.error("Unexpected roadmap generation failure.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ error: "Failed to generate the study roadmap." }, { status: 502 });
  }
}