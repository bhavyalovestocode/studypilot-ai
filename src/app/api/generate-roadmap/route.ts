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

interface RoadmapTask {
  id: string;
  title: string;
  subject: string;
  estimatedMinutes: number;
  completed: boolean;
}

interface RoadmapDay {
  day: number;
  date: string;
  theoryTopics: RoadmapTask[];
  exercises: RoadmapTask[];
  practiceQuestions: RoadmapTask[];
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
      !Array.isArray(day.theoryTopics) ||
      !Array.isArray(day.exercises) ||
      !Array.isArray(day.practiceQuestions) ||
      day.theoryTopics.length === 0 ||
      day.exercises.length === 0 ||
      day.practiceQuestions.length === 0
    ) {
      return false;
    }

    return [day.theoryTopics, day.exercises, day.practiceQuestions].every((tasks) =>
      tasks.every(
        (task) =>
          isRecord(task) &&
          typeof task.id === "string" &&
          typeof task.title === "string" &&
          typeof task.subject === "string" &&
          typeof task.estimatedMinutes === "number" &&
          Number.isFinite(task.estimatedMinutes) &&
          task.estimatedMinutes > 0 &&
          typeof task.completed === "boolean",
      ),
    );
  });
}

function getUtcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function sanitizeJsonResponse(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const withoutCodeBlock = fencedMatch?.[1]?.trim() ?? trimmed;
  const objectStart = withoutCodeBlock.indexOf("{");
  const objectEnd = withoutCodeBlock.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    return withoutCodeBlock.slice(objectStart, objectEnd + 1);
  }

  return withoutCodeBlock;
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
  const systemPrompt = `
You are an elite AI academic strategist and curriculum planner for "StudyPilot AI". Your job is to generate a rigorous, realistic, and perfectly paced day-by-day study roadmap that balances theory learning, chapter exercises, and active practice questions.

CRITICAL SCHEDULING & PEDAGOGY RULES:
1. DATE RANGE SPREAD: Calculate the exact number of days available between today and the target exam date. You MUST distribute the curriculum smoothly across ALL available days. Never pack all topics into the first few days.
2. INTEGRATED EXERCISES & PRACTICE: Do not separate theory and practice into isolated blocks at the very end. Every study day must structurally integrate:
   - Core Topic Review / Reading
   - Chapter Exercises (applying concepts learned)
   - Active Practice Questions / Problem-Solving blocks
   Every study day must contain at least one concrete task in each of the three JSON arrays: "theoryTopics", "exercises", and "practiceQuestions". A day containing only topic titles is invalid.
3. DAILY HOUR BUDGET: The user has specified a maximum of ${dailyHours} hours per day. Allocate time slots realistically (e.g., 60% theory/exercises, 40% active practice) so daily hours match this budget without overloading or underutilizing time.
4. PACING & AVOIDANCE OF EARLY FINISHES: Never finish the entire syllabus in 1-2 days and mark the rest as "rest". Keep a steady, sustainable daily cognitive load right up until the exam date.
5. JSON FORMAT: Return strictly valid JSON matching the requested schema. No conversational intro or outro text. Never use a generic "topics" field.
`;

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: systemPrompt,
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
      "theoryTopics": [
        {
          "id": "unique-theory-string",
          "title": "Core topic review or reading",
          "subject": "Subject name",
          "estimatedMinutes": 60,
          "completed": false
        }
      ],
      "exercises": [
        {
          "id": "unique-exercise-string",
          "title": "Chapter exercise set",
          "subject": "Subject name",
          "estimatedMinutes": 30,
          "completed": false
        }
      ],
      "practiceQuestions": [
        {
          "id": "unique-practice-string",
          "title": "Active practice question set",
          "subject": "Subject name",
          "estimatedMinutes": 30,
          "completed": false
        }
      ]
    }
  ]
}

Create one roadmap entry for each study day from today through the day before the exam. Every study day MUST have at least one item in each of "theoryTopics", "exercises", and "practiceQuestions"; never replace these arrays with a generic "topics" array. Each item must be a concrete, actionable task, not just a subject label. Distribute the syllabus across all available days. Use at most ${dailyHours * 60} total estimated minutes across all three arrays per day, and allocate time to theory, exercises, and practice realistically. Set every completed value to false. Use unique IDs across the entire roadmap. If there are no study days, return {"roadmap":[]}.

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
      parsedResponse = JSON.parse(sanitizeJsonResponse(content));
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