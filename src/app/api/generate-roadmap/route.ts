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
const DAYS_PER_PROVIDER_BATCH = 3;

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

type RoadmapValidationFailure = {
  stage: "structure" | "schedule" | "coverage";
  code: string;
  message: string;
};

const taskGroups = ["theoryTopics", "exercises", "practiceQuestions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTask(value: unknown): value is RoadmapTask {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.subject === "string" &&
    value.subject.trim().length > 0 &&
    typeof value.estimatedMinutes === "number" &&
    Number.isFinite(value.estimatedMinutes) &&
    value.estimatedMinutes > 0 &&
    typeof value.completed === "boolean"
  );
}

function isRoadmapResponse(value: unknown): value is RoadmapResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.roadmap) &&
    value.roadmap.every(
      (day) =>
        isRecord(day) &&
        typeof day.day === "number" &&
        Number.isInteger(day.day) &&
        typeof day.date === "string" &&
        taskGroups.every(
          (group) => Array.isArray(day[group]) && day[group].length > 0 && day[group].every(isTask),
        ),
    )
  );
}

function getUtcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getStudyDates(today: Date, days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function createScheduleSkeleton(studyDates: string[]): RoadmapDay[] {
  return studyDates.map((date, index) => ({
    day: index + 1,
    date,
    theoryTopics: [],
    exercises: [],
    practiceQuestions: [],
  }));
}

function sanitizeJsonResponse(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}

function normalizeProviderResponse(value: unknown): unknown {
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

function parseProviderResponse(content: string): unknown {
  return normalizeProviderResponse(JSON.parse(sanitizeJsonResponse(content)));
}

function describeBatchFailures(
  value: unknown,
  requestedDays: RoadmapDay[],
): RoadmapValidationFailure[] {
  if (!isRoadmapResponse(value)) {
    return [
      {
        stage: "structure",
        code: "invalid-task-response",
        message:
          "The AI response must contain non-empty theoryTopics, exercises, and practiceQuestions for every supplied day.",
      },
    ];
  }

  const failures: RoadmapValidationFailure[] = [];
  if (value.roadmap.length !== requestedDays.length) {
    failures.push({
      stage: "schedule",
      code: "incomplete-ai-response",
      message: `The AI response covered ${value.roadmap.length} of ${requestedDays.length} supplied study days. No partial roadmap was accepted.`,
    });
  }

  const requestedDayNumbers = new Set(requestedDays.map((day) => day.day));
  const returnedDayNumbers = new Set<number>();
  value.roadmap.forEach((day) => {
    if (!requestedDayNumbers.has(day.day)) {
      failures.push({
        stage: "schedule",
        code: "unexpected-day",
        message: `The AI returned tasks for day ${day.day}, which was not in the supplied schedule batch.`,
      });
    }
    if (returnedDayNumbers.has(day.day)) {
      failures.push({
        stage: "schedule",
        code: "duplicate-day",
        message: `The AI returned day ${day.day} more than once.`,
      });
    }
    returnedDayNumbers.add(day.day);
  });

  requestedDays.forEach((day) => {
    if (!returnedDayNumbers.has(day.day)) {
      failures.push({
        stage: "schedule",
        code: "missing-day",
        message: `The AI returned no tasks for supplied day ${day.day}.`,
      });
    }
  });

  return failures;
}

function getSyllabusRequirements(syllabusText: string): string[] {
  return syllabusText
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[,:;|]/))
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter((part) => part.length >= 3)
    .filter((part, index, parts) => parts.indexOf(part) === index);
}

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4);
}

function findMissingCoverage(roadmap: RoadmapDay[], syllabusText: string): string[] {
  const generatedText = roadmap
    .flatMap((day) => taskGroups.flatMap((group) => day[group]))
    .map((task) => `${task.title} ${task.subject}`)
    .join(" ");
  const generatedWords = new Set(normalizeWords(generatedText));

  return getSyllabusRequirements(syllabusText).filter((requirement) => {
    const words = normalizeWords(requirement);
    return words.length > 0 && !words.some((word) => generatedWords.has(word));
  });
}

function describeFinalFailures(
  roadmap: RoadmapDay[],
  schedule: RoadmapDay[],
  dailyHours: number,
  syllabusText: string,
): RoadmapValidationFailure[] {
  const failures: RoadmapValidationFailure[] = [];
  const ids = new Set<string>();
  const capacity = dailyHours * 60;

  if (roadmap.length !== schedule.length) {
    failures.push({
      stage: "schedule",
      code: "wrong-day-count",
      message: `The completed roadmap contains ${roadmap.length} days, but the application schedule requires ${schedule.length}.`,
    });
  }

  schedule.forEach((scheduledDay, index) => {
    const day = roadmap[index];
    if (!day || day.day !== scheduledDay.day || day.date !== scheduledDay.date) {
      failures.push({
        stage: "schedule",
        code: "invalid-merged-schedule",
        message: `The completed roadmap did not preserve the application-owned day ${scheduledDay.day} and date ${scheduledDay.date}.`,
      });
      return;
    }

    const tasks = taskGroups.flatMap((group) => day[group]);
    const totalMinutes = tasks.reduce((total, task) => total + task.estimatedMinutes, 0);
    if (totalMinutes > capacity) {
      failures.push({
        stage: "schedule",
        code: "daily-capacity-exceeded",
        message: `Day ${day.day} contains ${totalMinutes} minutes, exceeding the ${capacity}-minute daily capacity.`,
      });
    }

    tasks.forEach((task) => {
      if (ids.has(task.id)) {
        failures.push({
          stage: "structure",
          code: "duplicate-task-id",
          message: `Task ID "${task.id}" is used more than once.`,
        });
      }
      ids.add(task.id);
    });
  });

  const missingCoverage = findMissingCoverage(roadmap, syllabusText);
  if (missingCoverage.length > 0) {
    failures.push({
      stage: "coverage",
      code: "missing-syllabus-coverage",
      message: `The generated tasks do not cover: ${missingCoverage.slice(0, 5).join(", ")}${missingCoverage.length > 5 ? " and more." : "."}`,
    });
  }

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

function getFailureResponse(failures: RoadmapValidationFailure[], fallback: string) {
  const firstFailure = failures[0];
  return NextResponse.json(
    {
      error: firstFailure ? `${fallback} ${firstFailure.message}` : fallback,
      details: failures.map(({ code, message }) => ({ code, message })),
    },
    { status: ROADMAP_FAILURE_STATUS },
  );
}

function buildBatchPrompts(
  batch: RoadmapDay[],
  syllabusText: string,
  dailyHours: number,
  examDate: string,
) {
  const skeleton = batch.map(({ day, date }) => ({ day, date }));
  return {
    system: `You are StudyPilot AI's curriculum task planner. The application owns the schedule. You must not add, remove, reorder, renumber, or date any study day. Return only valid JSON with a "roadmap" array containing one task-filled object for every supplied day. Every day must have at least one theoryTopics task, one exercises task, and one practiceQuestions task. Keep each day's total estimatedMinutes at or below ${dailyHours * 60}. Use unique IDs across this entire request. Set completed to false. Do not omit syllabus requirements. Do not return explanations outside JSON.`,
    user: `Create educational tasks for this exact application-owned schedule batch:

${JSON.stringify(skeleton, null, 2)}

The exam date is ${examDate}. The student has ${dailyHours} hours per day. Distribute the syllabus progressively: introduce theory before exercises, then practice, while revisiting earlier material when useful. If the syllabus is too large for the supplied capacity, still return tasks only when they can fit; the application will reject an overloaded or incomplete result.

Return this shape:
{
  "roadmap": [
    {
      "day": 1,
      "date": "provided date, unchanged",
      "theoryTopics": [{"id":"unique-id","title":"actionable theory task","subject":"subject or chapter","estimatedMinutes":30,"completed":false}],
      "exercises": [{"id":"unique-id","title":"actionable exercise task","subject":"subject or chapter","estimatedMinutes":20,"completed":false}],
      "practiceQuestions": [{"id":"unique-id","title":"actionable practice task","subject":"subject or chapter","estimatedMinutes":20,"completed":false}]
    }
  ]
}

Syllabus requirements:
${syllabusText}`,
  };
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
  if (Number.isNaN(parsedExamDate.getTime()) || parsedExamDate.toISOString().slice(0, 10) !== examDate) {
    return NextResponse.json({ error: "examDate must be a valid date." }, { status: 400 });
  }

  const today = getUtcDate(new Date());
  const examDay = getUtcDate(parsedExamDate);
  const daysRemaining = Math.ceil((examDay.getTime() - today.getTime()) / MILLISECONDS_PER_DAY);
  if (daysRemaining < 0) {
    return NextResponse.json({ error: "examDate must be today or in the future." }, { status: 400 });
  }

  const todayString = today.toISOString().slice(0, 10);
  const examDayString = examDay.toISOString().slice(0, 10);
  const schedule = createScheduleSkeleton(getStudyDates(today, daysRemaining));
  if (schedule.length === 0) return NextResponse.json({ roadmap: [] });

  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is missing; roadmap generation is unavailable.");
    return NextResponse.json({ error: "GROQ_API_KEY is not configured." }, { status: 500 });
  }

  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    maxRetries: 0,
    timeout: PROVIDER_TIMEOUT_MS,
  });
  const mergedRoadmap: RoadmapDay[] = [];

  try {
    for (let start = 0; start < schedule.length; start += DAYS_PER_PROVIDER_BATCH) {
      const batch = schedule.slice(start, start + DAYS_PER_PROVIDER_BATCH);
      const prompts = buildBatchPrompts(batch, syllabusText.trim(), dailyHours, examDayString);
      console.info("Requesting deterministic roadmap task batch from Groq.", {
        model: MODEL,
        batchStartDay: batch[0].day,
        batchEndDay: batch[batch.length - 1].day,
        totalDays: schedule.length,
        dailyHours,
        responseFormat: "json_object",
      });

      const completion = await groq.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompts.system },
          { role: "user", content: prompts.user },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      if (typeof content !== "string") {
        const failures: RoadmapValidationFailure[] = [{
          stage: "structure",
          code: "empty-provider-response",
          message: `The AI returned no tasks for days ${batch[0].day}-${batch[batch.length - 1].day}.`,
        }];
        logRoadmapFailure("response extraction", failures, { model: MODEL, batchSize: batch.length });
        return getFailureResponse(failures, "The AI response was incomplete.");
      }

      let parsed: unknown;
      try {
        parsed = parseProviderResponse(content);
      } catch (error) {
        const failures: RoadmapValidationFailure[] = [{
          stage: "structure",
          code: "invalid-json",
          message: error instanceof Error ? error.message : "The AI response could not be parsed as JSON.",
        }];
        logRoadmapFailure("JSON parsing", failures, { model: MODEL, responseLength: content.length });
        return getFailureResponse(failures, "The AI returned invalid JSON.");
      }

      const batchFailures = describeBatchFailures(parsed, batch);
      if (batchFailures.length > 0) {
        logRoadmapFailure("batch validation", batchFailures, {
          model: MODEL,
          batchStartDay: batch[0].day,
          batchEndDay: batch[batch.length - 1].day,
        });
        return getFailureResponse(batchFailures, "The AI response was incomplete or invalid.");
      }

      const providerDays = (parsed as RoadmapResponse).roadmap;
      const providerDaysByNumber = new Map(providerDays.map((day) => [day.day, day]));
      batch.forEach((scheduledDay) => {
        const generatedDay = providerDaysByNumber.get(scheduledDay.day);
        if (!generatedDay) return;
        mergedRoadmap.push({
          ...scheduledDay,
          theoryTopics: generatedDay.theoryTopics.map((task) => ({ ...task, completed: false })),
          exercises: generatedDay.exercises.map((task) => ({ ...task, completed: false })),
          practiceQuestions: generatedDay.practiceQuestions.map((task) => ({ ...task, completed: false })),
        });
      });
    }

    const finalFailures = describeFinalFailures(mergedRoadmap, schedule, dailyHours, syllabusText.trim());
    if (finalFailures.length > 0) {
      logRoadmapFailure("final roadmap validation", finalFailures, {
        model: MODEL,
        requestedDays: schedule.length,
        actualDays: mergedRoadmap.length,
        today: todayString,
        examDate: examDayString,
      });
      const fallback =
        finalFailures.some(({ code }) => code === "missing-syllabus-coverage")
          ? "The requested syllabus exceeds the available study time or generated tasks did not cover every requirement."
          : "The AI generated tasks that could not be safely scheduled.";
      return getFailureResponse(finalFailures, fallback);
    }

    return NextResponse.json({ roadmap: mergedRoadmap });
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.error("Groq rate limit reached while generating roadmap.", { status: error.status });
      return NextResponse.json({ error: "The AI service is busy. Please try again shortly." }, { status: 429 });
    }
    if (error instanceof APIConnectionTimeoutError) {
      console.error("Groq request timed out while generating roadmap.", { timeoutMs: PROVIDER_TIMEOUT_MS });
      return NextResponse.json({ error: "The AI service took too long to respond. Please try again." }, { status: 504 });
    }
    if (error instanceof APIError) {
      const modelUnavailable =
        error.status === 404 || /model.{0,30}(not found|unsupported|available)/i.test(error.message);
      if (modelUnavailable) {
        console.error("Configured Groq roadmap model is unavailable.", { model: MODEL, status: error.status });
        return NextResponse.json(
          { error: `The configured Groq model "${MODEL}" is unavailable for this account. Check the model configuration.` },
          { status: ROADMAP_FAILURE_STATUS },
        );
      }
      if (error.status === 401 || error.status === 403) {
        console.error("Groq roadmap credentials are unauthorized.", { status: error.status });
        return NextResponse.json(
          { error: "The AI service credentials are invalid or unauthorized. Check GROQ_API_KEY." },
          { status: ROADMAP_FAILURE_STATUS },
        );
      }
      console.error("Groq rejected the roadmap request.", {
        status: error.status ?? "unknown",
        message: error.message.slice(0, 200),
      });
      return NextResponse.json({ error: "The AI provider is temporarily unavailable. Please try again." }, { status: ROADMAP_FAILURE_STATUS });
    }
    console.error("Unexpected roadmap generation failure.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ error: "The AI provider is temporarily unavailable. Please try again." }, { status: ROADMAP_FAILURE_STATUS });
  }
}
