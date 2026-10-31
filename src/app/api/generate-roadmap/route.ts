import Groq, {
  APIConnectionTimeoutError,
  APIError,
  RateLimitError,
} from "groq-sdk";
import { NextResponse } from "next/server";

const MODEL = "openai/gpt-oss-120b";
const MIN_DAILY_HOURS = 1;
const MAX_DAILY_HOURS = 12;
const PROVIDER_TIMEOUT_MS = 30_000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const ROADMAP_FAILURE_STATUS = 502;

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

type RoadmapValidationFailure = {
  stage: "structure" | "schedule";
  code: string;
  message: string;
};

function describeRoadmapValidation(
  value: unknown,
  todayString: string,
  examDayString: string,
  dailyHours: number,
): RoadmapValidationFailure[] {
  const failures: RoadmapValidationFailure[] = [];
  if (!isRecord(value) || !Array.isArray(value.roadmap)) {
    return [
      {
        stage: "structure",
        code: "missing-roadmap-array",
        message: 'The response must be an object containing a "roadmap" array.',
      },
    ];
  }

  value.roadmap.forEach((day, dayIndex) => {
    if (!isRecord(day)) {
      failures.push({
        stage: "structure",
        code: "invalid-day",
        message: `Roadmap entry ${dayIndex + 1} is not an object.`,
      });
      return;
    }

    if (
      typeof day.day !== "number" ||
      !Number.isInteger(day.day) ||
      typeof day.date !== "string" ||
      !Array.isArray(day.theoryTopics) ||
      !Array.isArray(day.exercises) ||
      !Array.isArray(day.practiceQuestions)
    ) {
      failures.push({
        stage: "structure",
        code: "invalid-day-shape",
        message: `Roadmap entry ${dayIndex + 1} must include integer day, date, and all three task arrays.`,
      });
      return;
    }

    (["theoryTopics", "exercises", "practiceQuestions"] as const).forEach((group) => {
      const tasks: unknown[] = Array.isArray(day[group]) ? day[group] : [];
      if (tasks.length === 0) {
        failures.push({
          stage: "structure",
          code: "empty-task-group",
          message: `Day ${dayIndex + 1} has no ${group} tasks.`,
        });
      }

      tasks.forEach((task, taskIndex) => {
        if (
          !isRecord(task) ||
          typeof task.id !== "string" ||
          typeof task.title !== "string" ||
          typeof task.subject !== "string" ||
          typeof task.estimatedMinutes !== "number" ||
          !Number.isFinite(task.estimatedMinutes) ||
          task.estimatedMinutes <= 0 ||
          typeof task.completed !== "boolean"
        ) {
          failures.push({
            stage: "structure",
            code: "invalid-task",
            message: `Day ${dayIndex + 1} ${group} task ${taskIndex + 1} has an invalid shape or estimatedMinutes value.`,
          });
        }
      });
    });
  });

  const expectedDays = Math.max(
    0,
    Math.ceil(
      (new Date(`${examDayString}T00:00:00Z`).getTime() -
        new Date(`${todayString}T00:00:00Z`).getTime()) /
        MILLISECONDS_PER_DAY,
    ),
  );
  if (value.roadmap.length !== expectedDays) {
    failures.push({
      stage: "schedule",
      code: "wrong-day-count",
      message: `Expected exactly ${expectedDays} study days, but Groq returned ${value.roadmap.length}.`,
    });
  }

  const ids = new Set<string>();
  value.roadmap.forEach((day, index) => {
    if (!isRecord(day)) return;
    const expectedDate = new Date(`${todayString}T00:00:00Z`);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + index);
    const expectedDateString = expectedDate.toISOString().slice(0, 10);
    if (day.day !== index + 1 || day.date !== expectedDateString) {
      failures.push({
        stage: "schedule",
        code: "invalid-date-sequence",
        message: `Day ${index + 1} must use day ${index + 1} and date ${expectedDateString}; received day ${String(day.day)} and date ${String(day.date)}.`,
      });
    }

    const tasks = (["theoryTopics", "exercises", "practiceQuestions"] as const).flatMap((group) =>
      Array.isArray(day[group]) ? day[group] : [],
    );
    const totalMinutes = tasks.reduce(
      (total, task) =>
        isRecord(task) && typeof task.estimatedMinutes === "number"
          ? total + task.estimatedMinutes
          : total,
      0,
    );
    if (totalMinutes > dailyHours * 60) {
      failures.push({
        stage: "schedule",
        code: "daily-capacity-exceeded",
        message: `Day ${index + 1} contains ${totalMinutes} minutes, exceeding the ${dailyHours * 60}-minute daily capacity.`,
      });
    }
    tasks.forEach((task) => {
      if (!isRecord(task) || typeof task.id !== "string") return;
      if (ids.has(task.id)) {
        failures.push({
          stage: "schedule",
          code: "duplicate-task-id",
          message: `Task ID "${task.id}" is used more than once.`,
        });
      }
      ids.add(task.id);
    });
  });

  return failures;
}

function logRoadmapFailure(
  stage: string,
  failures: RoadmapValidationFailure[],
  metadata: Record<string, unknown>,
) {
  console.error(`Roadmap generation failed during ${stage}.`, {
    ...metadata,
    failures: failures.map(({ code, message }) => ({ code, message })),
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

function coerceRoadmapResponse(value: unknown): unknown {
  if (isRoadmapResponse(value) || !isRecord(value)) return value;

  const keys = Object.keys(value).sort((left, right) => Number(left) - Number(right));
  if (
    keys.length === 0 ||
    keys.some((key, index) => key !== String(index)) ||
    keys.some((key) => !isRecord(value[key]))
  ) {
    return value;
  }

  return { roadmap: keys.map((key) => value[key]) };
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    console.error("Roadmap request validation failed: request body was not valid JSON.");
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!isRecord(body)) {
    console.error("Roadmap request validation failed: body was not a JSON object.");
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
    console.error("Roadmap request validation failed: invalid input fields.", {
      hasSyllabusText: typeof syllabusText === "string" && syllabusText.trim().length > 0,
      examDateType: typeof examDate,
      dailyHours,
    });
    return NextResponse.json(
      {
        error:
          `syllabusText and examDate must be non-empty strings, and dailyHours must be a finite number from ${MIN_DAILY_HOURS} to ${MAX_DAILY_HOURS}.`,
      },
      { status: 400 },
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
    console.error("Roadmap request validation failed: examDate has the wrong format.");
    return NextResponse.json({ error: "examDate must use the YYYY-MM-DD format." }, { status: 400 });
  }

  const parsedExamDate = new Date(examDate);
  if (
    Number.isNaN(parsedExamDate.getTime()) ||
    parsedExamDate.toISOString().slice(0, 10) !== examDate
  ) {
    console.error("Roadmap request validation failed: examDate is not a valid calendar date.", {
      examDate,
    });
    return NextResponse.json({ error: "examDate must be a valid date." }, { status: 400 });
  }

  const today = getUtcDate(new Date());
  const examDay = getUtcDate(parsedExamDate);
  const daysRemaining = Math.ceil(
    (examDay.getTime() - today.getTime()) / MILLISECONDS_PER_DAY,
  );

  if (daysRemaining < 0) {
    console.error("Roadmap request validation failed: examDate is in the past.", {
      today: today.toISOString().slice(0, 10),
      examDate,
    });
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
  const studyDates = Array.from({ length: daysRemaining }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const systemPrompt = `
You are an elite AI academic strategist and curriculum planner for "StudyPilot AI". Your job is to generate a rigorous, realistic, and perfectly paced day-by-day study roadmap that balances theory learning, chapter exercises, and active practice questions.

CRITICAL SCHEDULING & PEDAGOGY RULES:
1. DATE RANGE SPREAD: Calculate the exact number of days available between today and the target exam date. You MUST distribute the curriculum smoothly across ALL available days. Never pack all topics into the first few days.
   The roadmap MUST contain exactly ${daysRemaining} entries. Use every date in this exact order: ${studyDates.join(", ") || "(none)"}.
2. INTEGRATED EXERCISES & PRACTICE: Do not separate theory and practice into isolated blocks at the very end. Every study day must structurally integrate:
   - Core Topic Review / Reading
   - Chapter Exercises (applying concepts learned)
   - Active Practice Questions / Problem-Solving blocks
   Every study day must contain at least one concrete task in each of the three JSON arrays: "theoryTopics", "exercises", and "practiceQuestions". A day containing only topic titles is invalid.
3. DAILY HOUR BUDGET: The user has specified a maximum of ${dailyHours} hours per day. Allocate realistic time slots (e.g., 60% theory/exercises, 40% active practice), but never exceed the daily limit. Using less time is valid when the syllabus does not require the full budget.
4. PACING & AVOIDANCE OF EARLY FINISHES: Never finish the entire syllabus in 1-2 days and mark the rest as "rest". Keep a steady, sustainable daily cognitive load right up until the exam date.
5. JSON FORMAT: Return strictly valid JSON matching the requested schema. No conversational intro or outro text. Never use a generic "topics" field.
`;

  try {
    console.info("Requesting roadmap from Groq.", {
      model: MODEL,
      requestedDays: daysRemaining,
      dailyHours,
      responseFormat: "json_object",
    });
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

Create exactly ${daysRemaining} roadmap entries. The "roadmap" array length must be exactly ${daysRemaining}; do not stop early or combine dates. Use the exact date list above, in order, with day values 1 through ${daysRemaining}. Every study day MUST have at least one item in each of "theoryTopics", "exercises", and "practiceQuestions"; never replace these arrays with a generic "topics" array. Each item must be a concrete, actionable task, not just a subject label. Distribute the syllabus across all available days. Use at most ${dailyHours * 60} total estimated minutes across all three arrays per day, and allocate time to theory, exercises, and practice realistically. Set every completed value to false. Use unique IDs across the entire roadmap. If there are no study days, return {"roadmap":[]}.

Syllabus:
${syllabusText.trim()}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string") {
      logRoadmapFailure("response extraction", [
        { stage: "structure", code: "empty-provider-response", message: "Groq returned no text content." },
      ], { model: MODEL, requestedDays: daysRemaining });
      return NextResponse.json({ error: "Groq returned an empty response." }, { status: 502 });
    }

    let parsedResponse: unknown;
    try {
      const sanitizedContent = sanitizeJsonResponse(content);
      const decodedResponse = JSON.parse(sanitizedContent);
      parsedResponse = coerceRoadmapResponse(decodedResponse);
      if (parsedResponse !== decodedResponse) {
        console.info("Normalized numeric-key roadmap response from Groq.", {
          model: MODEL,
          requestedDays: daysRemaining,
          originalKeys: isRecord(decodedResponse) ? Object.keys(decodedResponse).slice(0, 20) : [],
        });
      }
    } catch (error) {
      logRoadmapFailure("JSON parsing", [
        { stage: "structure", code: "invalid-json", message: error instanceof Error ? error.message : "JSON.parse failed." },
      ], { model: MODEL, requestedDays: daysRemaining, responseLength: content.length });
      return NextResponse.json({ error: "Groq returned invalid JSON. Ask it to return the requested roadmap JSON without additional text." }, { status: ROADMAP_FAILURE_STATUS });
    }

    const validationFailures = describeRoadmapValidation(
      parsedResponse,
      todayString,
      examDayString,
      dailyHours,
    );
    if (validationFailures.length > 0) {
      const validationStage = validationFailures.some(({ stage }) => stage === "schedule")
        ? "semantic roadmap validation"
        : "roadmap structure validation";
      logRoadmapFailure(validationStage, validationFailures, {
        model: MODEL,
        requestedDays: daysRemaining,
        actualDays: isRecord(parsedResponse) && Array.isArray(parsedResponse.roadmap)
          ? parsedResponse.roadmap.length
          : null,
        responseShape: isRecord(parsedResponse) ? Object.keys(parsedResponse).slice(0, 20) : typeof parsedResponse,
      });
      return NextResponse.json(
        {
          error: `Groq returned an invalid roadmap: ${validationFailures[0].message}`,
          details: validationFailures.map(({ code, message }) => ({ code, message })),
        },
        { status: ROADMAP_FAILURE_STATUS },
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
      const modelUnavailable =
        error.status === 404 || /model.{0,30}(not found|unsupported|available)/i.test(error.message);
      if (modelUnavailable) {
        console.error("Configured Groq roadmap model is unavailable.", {
          model: MODEL,
          status: error.status ?? "unknown",
          message: error.message.slice(0, 200),
        });
        return NextResponse.json(
          { error: `The configured Groq model "${MODEL}" is unavailable for this account. Check the model configuration.` },
          { status: ROADMAP_FAILURE_STATUS },
        );
      }
      if (error.status === 401 || error.status === 403) {
        console.error("Groq rejected the roadmap request because the configured credentials are unauthorized.", {
          status: error.status,
        });
        return NextResponse.json(
          { error: "The AI service credentials are invalid or unauthorized. Check GROQ_API_KEY." },
          { status: 502 },
        );
      }
      console.error("Groq rejected the roadmap request.", {
        status: error.status ?? "unknown",
        message: error.message.slice(0, 200),
      });
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