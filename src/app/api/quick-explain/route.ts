import Groq, {
  APIConnectionTimeoutError,
  APIError,
  RateLimitError,
} from "groq-sdk";
import { NextResponse } from "next/server";

const MODEL = "llama-3.3-70b-versatile";
const PROVIDER_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isQuickExplanation(value: unknown): value is { explanation: string } {
  return isRecord(value) && typeof value.explanation === "string" && value.explanation.trim().length > 0;
}

function sanitizeJson(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!isRecord(body) || typeof body.topic !== "string" || body.topic.trim().length === 0) {
    return NextResponse.json({ error: "topic must be a non-empty string." }, { status: 400 });
  }

  const topic = body.topic.trim();
  if (topic.length > 300) {
    return NextResponse.json({ error: "topic must be 300 characters or fewer." }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is missing; quick explanations are unavailable.");
    return NextResponse.json({ error: "GROQ_API_KEY is not configured." }, { status: 500 });
  }

  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    maxRetries: 0,
    timeout: PROVIDER_TIMEOUT_MS,
  });

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You are a concise academic tutor. Return only valid JSON with exactly this shape: {"explanation":"..."}. The explanation must contain exactly three short bullet points and one simple everyday analogy. Keep it under 120 words. Do not add any other fields.',
        },
        {
          role: "user",
          content: `Explain this syllabus topic for a student in three concise bullets and one simple analogy:\n\n${topic}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string") {
      return NextResponse.json({ error: "Groq returned an empty explanation." }, { status: 502 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(sanitizeJson(content));
    } catch {
      return NextResponse.json({ error: "Groq returned invalid explanation JSON." }, { status: 502 });
    }

    if (!isQuickExplanation(parsed)) {
      return NextResponse.json(
        { error: "Groq returned an explanation with an invalid format." },
        { status: 502 },
      );
    }

    return NextResponse.json(parsed);
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.error("Groq rate limit reached for quick explanation.", { status: error.status });
      return NextResponse.json({ error: "The AI service is busy. Please try again shortly." }, { status: 429 });
    }

    if (error instanceof APIConnectionTimeoutError) {
      console.error("Groq quick explanation request timed out.", { timeoutMs: PROVIDER_TIMEOUT_MS });
      return NextResponse.json({ error: "The explanation took too long to generate." }, { status: 504 });
    }

    if (error instanceof APIError) {
      console.error("Groq rejected the quick explanation request.", {
        status: error.status,
        message: error.message,
      });
      return NextResponse.json({ error: "The AI service could not explain this topic right now." }, { status: 502 });
    }

    console.error("Unexpected quick explanation failure.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ error: "Failed to generate the explanation." }, { status: 502 });
  }
}
