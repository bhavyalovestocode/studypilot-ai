"use client";

import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Download,
  GraduationCap,
  LayoutDashboard,
  Lightbulb,
  Loader2,
  Menu,
  Pause,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Target,
  TrendingUp,
  Flame,
  Printer,
  Play,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

type StudyTask = {
  id: string;
  title: string;
  subject: string;
  estimatedMinutes: number;
  completed: boolean;
};

type RoadmapDay = {
  day: number;
  date: string;
  theoryTopics: StudyTask[];
  exercises: StudyTask[];
  practiceQuestions: StudyTask[];
};

const taskGroups = [
  { key: "theoryTopics", label: "Theory & review" },
  { key: "exercises", label: "Chapter exercises" },
  { key: "practiceQuestions", label: "Active practice" },
] as const;

function normalizeTask(value: unknown, fallbackId: string): StudyTask {
  const task = value && typeof value === "object" ? value as Partial<StudyTask> : {};
  return {
    id: typeof task.id === "string" && task.id ? task.id : fallbackId,
    title: typeof task.title === "string" ? task.title : "Study task",
    subject: typeof task.subject === "string" ? task.subject : "General",
    estimatedMinutes: typeof task.estimatedMinutes === "number" && Number.isFinite(task.estimatedMinutes)
      ? Math.max(0, task.estimatedMinutes)
      : 0,
    completed: task.completed === true,
  };
}

function normalizeRoadmap(value: unknown): RoadmapDay[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<RoadmapDay[]>((days, item, dayIndex) => {
    if (!item || typeof item !== "object") return days;
    const rawDay = item as Partial<RoadmapDay>;
    const getTasks = (key: (typeof taskGroups)[number]["key"]) =>
      (Array.isArray(rawDay[key]) ? rawDay[key] : []).map((task, taskIndex) =>
        normalizeTask(task, `day-${dayIndex + 1}-${key}-${taskIndex + 1}`),
      );

    days.push({
      day: typeof rawDay.day === "number" ? rawDay.day : dayIndex + 1,
      date: typeof rawDay.date === "string" ? rawDay.date : "",
      theoryTopics: getTasks("theoryTopics"),
      exercises: getTasks("exercises"),
      practiceQuestions: getTasks("practiceQuestions"),
    });
    return days;
  }, []);
}

function getDayTasks(day: RoadmapDay) {
  return taskGroups.flatMap(({ key }) => day?.[key] ?? []);
}

const STORAGE_KEY = "studypilot-roadmap";
const EXAM_DATE_STORAGE_KEY = "studypilot-exam-date";
const STREAK_STORAGE_KEY = "studypilot-streak";

type ProgressSummary = {
  total: number;
  completed: number;
  percentage: number;
};

type StreakRecord = {
  completedDates: string[];
};

export function calculateProgress(roadmap: RoadmapDay[]): ProgressSummary {
  const tasks = roadmap.flatMap(getDayTasks);
  const completed = tasks.filter((task) => task.completed).length;
  return {
    total: tasks.length,
    completed,
    percentage: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
  };
}

function calculateStreak(completedDates: string[]) {
  const dates = [...new Set(completedDates)].sort().reverse();
  if (dates.length === 0) return 0;

  let streak = 1;
  for (let index = 1; index < dates.length; index += 1) {
    const previous = new Date(`${dates[index - 1]}T00:00:00Z`).getTime();
    const current = new Date(`${dates[index]}T00:00:00Z`).getTime();
    if (previous - current !== 24 * 60 * 60 * 1000) break;
    streak += 1;
  }
  return streak;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function escapeIcsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function formatIcsDate(date: string) {
  return date.replace(/-/g, "");
}

function getNextDate(date: string) {
  const nextDate = new Date(`${date}T12:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate.toISOString().slice(0, 10);
}

export function createRoadmapIcs(roadmap: RoadmapDay[]) {
  const events = roadmap
    .filter((day) => day.date)
    .map((day) => {
      const tasks = getDayTasks(day);
      const description = tasks
        .map((task) => `${task.completed ? "[Done] " : ""}${task.title} (${formatMinutes(task.estimatedMinutes)})`)
        .join("\n");
      return [
        "BEGIN:VEVENT",
        `UID:studypilot-day-${day.day}-${formatIcsDate(day.date)}@studypilot-ai`,
        `DTSTAMP:${formatIcsDate(getTodayString())}T000000Z`,
        `DTSTART;VALUE=DATE:${formatIcsDate(day.date)}`,
        `DTEND;VALUE=DATE:${formatIcsDate(getNextDate(day.date))}`,
        `SUMMARY:${escapeIcsText(`StudyPilot AI - Day ${day.day}`)}`,
        `DESCRIPTION:${escapeIcsText(description || "Study session")}`,
        "END:VEVENT",
      ].join("\r\n");
    });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StudyPilot AI//Roadmap//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function downloadRoadmapCalendar(roadmap: RoadmapDay[]) {
  const blob = new Blob([createRoadmapIcs(roadmap)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "studypilot-roadmap.ics";
  link.click();
  URL.revokeObjectURL(url);
}

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function getDaysUntil(examDate: string) {
  if (!examDate) return null;
  const today = new Date(`${getTodayString()}T00:00:00Z`);
  const target = new Date(`${examDate}T00:00:00Z`);
  const difference = Math.ceil((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  return Number.isFinite(difference) ? difference : null;
}

export default function Home() {
  const [view, setView] = useState<"setup" | "dashboard">("setup");
  const [syllabusText, setSyllabusText] = useState("");
  const [examDate, setExamDate] = useState("");
  const [dailyHours, setDailyHours] = useState(3);
  const [roadmap, setRoadmap] = useState<RoadmapDay[]>([]);
  const [expandedDays, setExpandedDays] = useState<number[]>([1]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRebalancing, setIsRebalancing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rebalancingError, setRebalancingError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [storedStreakDates] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = JSON.parse(window.localStorage.getItem(STREAK_STORAGE_KEY) ?? "{}") as Partial<StreakRecord>;
      return Array.isArray(stored.completedDates)
        ? stored.completedDates.filter((date): date is string => typeof date === "string")
        : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const storedRoadmap = window.localStorage.getItem(STORAGE_KEY);
    const storedExamDate = window.localStorage.getItem(EXAM_DATE_STORAGE_KEY);
    const restoreTimer = window.setTimeout(() => {
      if (storedExamDate) setExamDate(storedExamDate);
      if (storedRoadmap) {
        try {
          const saved = normalizeRoadmap(JSON.parse(storedRoadmap));
          if (saved.length > 0) {
            setRoadmap(saved);
            setView("dashboard");
          }
        } catch {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (roadmap.length > 0) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(roadmap));
    }
  }, [roadmap]);

  const completedStudyDates = useMemo(() => {
    const roadmapDates = new Set(roadmap.map((day) => day.date));
    const completedDates = roadmap
      .filter((day) => {
        const tasks = getDayTasks(day);
        return day.date && tasks.length > 0 && tasks.every((task) => task.completed);
      })
      .map((day) => day.date);
    return [...new Set([
      ...storedStreakDates.filter(
        (date) => !roadmapDates.has(date) || completedDates.includes(date),
      ),
      ...completedDates,
    ])];
  }, [roadmap, storedStreakDates]);

  useEffect(() => {
    window.localStorage.setItem(
      STREAK_STORAGE_KEY,
      JSON.stringify({ completedDates: completedStudyDates }),
    );
  }, [completedStudyDates]);

  const stats = useMemo(() => {
    const progress = calculateProgress(roadmap);
    return {
      ...progress,
      streak: calculateStreak(completedStudyDates),
    };
  }, [roadmap, completedStudyDates]);

  async function generateRoadmap() {
    setError("");
    setNotice("");
    setIsLoading(true);
    try {
      const response = await fetch("/api/generate-roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syllabusText, examDate, dailyHours }),
      });
      let data: { roadmap?: unknown; error?: string };
      try {
        data = (await response.json()) as { roadmap?: unknown; error?: string };
      } catch {
        throw new Error("The server returned an invalid response. Please try again.");
      }
      if (!response.ok || !data.roadmap) {
        throw new Error(data.error || "Unable to generate your strategy.");
      }
      const normalizedRoadmap = normalizeRoadmap(data.roadmap);
      if (normalizedRoadmap.length === 0 && data.roadmap !== undefined) {
        throw new Error("The server returned an invalid roadmap. Please try again.");
      }
      setRoadmap(normalizedRoadmap);
      window.localStorage.setItem(EXAM_DATE_STORAGE_KEY, examDate);
      setExpandedDays([1]);
      setNotice("Your personalized roadmap is ready.");
      setView("dashboard");
    } catch (generationError) {
      setError(
        generationError instanceof TypeError
          ? "Unable to reach the server. Check your connection and try again."
          : generationError instanceof Error
            ? generationError.message
            : "Something went wrong.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function toggleTopic(dayNumber: number, topicId: string) {
    setRoadmap((current) =>
      current.map((day) =>
        day.day === dayNumber
          ? {
              ...day,
              ...Object.fromEntries(
                taskGroups.map(({ key }) => [
                  key,
                  (day?.[key] ?? []).map((topic) =>
                    topic.id === topicId ? { ...topic, completed: !topic.completed } : topic,
                  ),
                ]),
              ),
            }
          : day,
      ),
    );
  }

  function toggleDay(dayNumber: number) {
    setExpandedDays((current) =>
      current.includes(dayNumber)
        ? current.filter((day) => day !== dayNumber)
        : [...current, dayNumber],
    );
  }

  function rebalancePlan() {
    setIsRebalancing(true);
    setNotice("");
    setRebalancingError("");
    window.setTimeout(() => {
      try {
      setRoadmap((current) => {
        const unfinished = current.flatMap((day) =>
          taskGroups.flatMap(({ key }) =>
            (day?.[key] ?? [])
              .filter((topic) => !topic.completed)
              .map((topic) => ({ key, topic })),
          ),
        );
        const completedByDay = current.map((day) => ({
          ...day,
          ...Object.fromEntries(
            taskGroups.map(({ key }) => [key, (day?.[key] ?? []).filter((topic) => topic.completed)]),
          ),
        }));
        const capacity = dailyHours * 60;
        let topicIndex = 0;
        const rebalanced = completedByDay.map((day) => {
          const planned = getDayTasks(day);
          let minutes = planned.reduce((sum, topic) => sum + topic.estimatedMinutes, 0);
          while (
            topicIndex < unfinished.length &&
            (minutes + unfinished[topicIndex].topic.estimatedMinutes <= capacity || planned.length === 0)
          ) {
            const task = unfinished[topicIndex];
            (day[task.key] ??= []).push(task.topic);
            planned.push(task.topic);
            minutes += task.topic.estimatedMinutes;
            topicIndex += 1;
          }
          return day;
        });
        if (topicIndex < unfinished.length && rebalanced.length > 0) {
          const lastDay = rebalanced[rebalanced.length - 1];
          unfinished.slice(topicIndex).forEach(({ key, topic }) => (lastDay[key] ??= []).push(topic));
        }
        return rebalanced;
      });
      setIsRebalancing(false);
      setNotice("Your unfinished topics were redistributed without changing your exam date.");
      } catch {
        setIsRebalancing(false);
        setRebalancingError("We couldn't rebalance your plan. Your existing roadmap is unchanged.");
      }
    }, 650);
  }

  const activeDay = roadmap[0];

  if (view === "setup") {
    return (
      <SetupLanding
        syllabusText={syllabusText}
        examDate={examDate}
        dailyHours={dailyHours}
        isLoading={isLoading}
        error={error}
        onSyllabusChange={setSyllabusText}
        onDateChange={setExamDate}
        onHoursChange={setDailyHours}
        onGenerate={generateRoadmap}
      />
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-white/95 px-5 py-7 shadow-[8px_0_30px_rgb(16_17_36_/2%)] backdrop-blur lg:flex">
        <Brand />
        <div className="mt-14 mb-3 px-3"><p className="eyebrow">Workspace</p></div>
        <nav className="space-y-2">
          <button className="nav-item nav-item-active" onClick={() => setView(roadmap.length ? "dashboard" : "setup")}>
            <LayoutDashboard size={18} /> Overview
          </button>
          <button className="nav-item" onClick={() => setView("setup")}>
            <Sparkles size={18} /> New strategy
          </button>
        </nav>
        <div className="mt-auto rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 p-4">
          <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-violet-600 text-white shadow-lg shadow-violet-200">
            <Target size={18} />
          </div>
          <p className="text-sm font-semibold text-indigo-950">Small steps, big wins.</p>
          <p className="mt-1 text-xs leading-5 text-indigo-700">Consistency compounds. You&apos;ve got this.</p>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-20 items-center justify-between border-b bg-white/75 px-5 backdrop-blur-xl sm:px-8 lg:px-12">
          <button className="flex items-center gap-2 lg:hidden" onClick={() => setMobileNavOpen(true)}>
            <Menu size={20} />
            <Brand />
          </button>
          <div className="hidden lg:block">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Your learning workspace</p>
            <h1 className="mt-1 text-lg font-bold tracking-tight">Good to see you again</h1>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <div className="hidden items-center gap-2 rounded-full border bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm sm:flex">
              <span className="size-2 rounded-full bg-emerald-500" /> Focus mode on
            </div>
            <div className="flex size-9 items-center justify-center rounded-full bg-slate-950 text-xs font-bold text-white shadow-sm">SP</div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
          <DashboardView
              roadmap={roadmap}
              stats={stats}
              activeDay={activeDay}
              expandedDays={expandedDays}
              isRebalancing={isRebalancing}
              notice={notice}
              rebalancingError={rebalancingError}
              examDate={examDate}
              onToggleDay={toggleDay}
              onToggleTopic={toggleTopic}
              onRebalance={rebalancePlan}
              onNewStrategy={() => setView("setup")}
            />
        </main>
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/30 lg:hidden" onClick={() => setMobileNavOpen(false)}>
          <div className="h-full w-72 bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between"><Brand /><button onClick={() => setMobileNavOpen(false)}><X size={20} /></button></div>
            <nav className="mt-12 space-y-2">
              <button className="nav-item nav-item-active" onClick={() => { setView(roadmap.length ? "dashboard" : "setup"); setMobileNavOpen(false); }}><LayoutDashboard size={18} /> Overview</button>
              <button className="nav-item" onClick={() => { setView("setup"); setMobileNavOpen(false); }}><Sparkles size={18} /> New strategy</button>
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return <div className="flex items-center gap-2.5"><div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-200"><GraduationCap size={19} /></div><span className="text-base font-extrabold tracking-tight text-slate-950">StudyPilot<span className="text-violet-600"> AI</span></span></div>;
}

function SetupLanding({
  syllabusText,
  examDate,
  dailyHours,
  isLoading,
  error,
  onSyllabusChange,
  onDateChange,
  onHoursChange,
  onGenerate,
}: {
  syllabusText: string;
  examDate: string;
  dailyHours: number;
  isLoading: boolean;
  error: string;
  onSyllabusChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onHoursChange: (value: number) => void;
  onGenerate: () => void;
}) {
  const [today, setToday] = useState("");
  useEffect(() => {
    const todayTimer = window.setTimeout(() => {
      setToday(new Date().toISOString().slice(0, 10));
    }, 0);
    return () => window.clearTimeout(todayTimer);
  }, []);

  const dateError = today.length > 0 && examDate.length > 0 && examDate < today;
  const canSubmit = syllabusText.trim().length > 0 && Boolean(examDate) && !dateError;

  return (
    <main className="page-enter relative min-h-screen overflow-hidden bg-canvas px-5 py-6 sm:px-8 lg:px-14">
      <div className="pointer-events-none absolute -right-40 -top-52 size-[34rem] rounded-full bg-violet-200/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-64 -left-40 size-[28rem] rounded-full bg-indigo-100/30 blur-3xl" />
      <header className="relative mx-auto flex max-w-7xl items-center justify-between">
        <Brand />
        <div className="flex items-center gap-4"><div className="hidden items-center gap-2 text-xs font-semibold text-slate-500 sm:flex"><span className="size-2 rounded-full bg-emerald-500" /> Built for focused progress</div><ThemeToggle /></div>
      </header>
      <div className="relative mx-auto grid max-w-7xl items-center gap-14 py-16 lg:grid-cols-[1fr_0.86fr] lg:gap-24 lg:py-24">
        <section>
          <div className="page-enter stagger-1 mb-7 inline-flex items-center gap-2 rounded-full border border-violet-100 bg-white/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-violet-700 shadow-sm"><Sparkles size={14} /> AI-powered study planning</div>
          <h1 className="page-enter stagger-2 max-w-2xl text-5xl font-black leading-[0.98] tracking-[-0.065em] text-slate-950 sm:text-7xl">Your syllabus.<br />Your <span className="bg-gradient-to-r from-violet-600 to-indigo-500 bg-clip-text text-transparent">strategy.</span><br />Your success.</h1>
          <p className="page-enter stagger-3 mt-8 max-w-xl text-base leading-8 text-slate-500 sm:text-lg">StudyPilot AI turns an overwhelming syllabus into an actionable daily roadmap, paced around your exam date, your time, and the way you learn.</p>
          <div className="page-enter stagger-4 mt-9 grid max-w-xl gap-3 sm:grid-cols-3">
            {[
              ["Personalized roadmaps", "Built around your target"],
              ["Adaptive scheduling", "Flexible when life happens"],
              ["Progress tracking", "Momentum you can see"],
            ].map(([title, detail]) => (
              <div key={title} className="flex gap-2.5 text-sm"><span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check size={13} strokeWidth={3} /></span><span><span className="block font-bold text-slate-800">{title}</span><span className="mt-1 block text-xs leading-5 text-slate-400">{detail}</span></span></div>
            ))}
          </div>
        </section>

        <section className="page-enter stagger-4 surface-card relative p-6 sm:p-9">
          <div className="absolute -right-3 -top-3 flex size-12 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-xl shadow-violet-200"><Target size={20} /></div>
          <div className="mb-8"><p className="text-2xl font-black tracking-tight text-slate-950">Let&apos;s map it out</p><p className="mt-2 text-sm text-slate-500">Tell us what you&apos;re preparing for.</p></div>
          <form onSubmit={(event) => { event.preventDefault(); if (canSubmit && !isLoading) onGenerate(); }}>
            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between"><label className="field-label mb-0" htmlFor="syllabus">Syllabus or topics</label><span className="text-xs tabular-nums text-slate-400">{syllabusText.length} characters</span></div>
              <textarea id="syllabus" value={syllabusText} onChange={(event) => onSyllabusChange(event.target.value)} placeholder={"e.g. Biology: cell structure, genetics, ecology\nMathematics: calculus, probability, statistics"} aria-describedby="syllabus-help" className="input-field min-h-44 resize-y leading-7" />
              <p id="syllabus-help" className="mt-2 text-xs text-slate-400">Paste subjects, chapters, or a full syllabus outline.</p>
            </div>
            <div className="mb-6">
              <label className="field-label" htmlFor="exam-date">Exam target date</label>
              <div className="relative"><CalendarDays className="input-icon" size={17} /><input id="exam-date" type="date" min={today} value={examDate} onChange={(event) => onDateChange(event.target.value)} aria-invalid={dateError} aria-describedby={dateError ? "date-error" : undefined} className={`input-field pl-10 ${dateError ? "border-rose-300 focus:border-rose-500 focus:ring-rose-500/10" : ""}`} /></div>
              {dateError && <p id="date-error" role="alert" className="mt-2 text-xs font-semibold text-rose-600">Choose today or a future date.</p>}
            </div>
            <div className="mb-7">
              <div className="mb-3 flex items-end justify-between"><label className="field-label mb-0" htmlFor="hours">Daily study hours</label><span className="text-2xl font-black tracking-tight text-violet-600">{dailyHours}<span className="ml-1 text-sm font-bold">hrs/day</span></span></div>
              <div className="rounded-xl border bg-slate-50/70 px-4 py-3"><input id="hours" type="range" min="1" max="12" step="0.5" value={dailyHours} onChange={(event) => onHoursChange(Number(event.target.value))} aria-valuetext={`${dailyHours} hours per day`} className="w-full cursor-pointer accent-violet-600" /><div className="mt-2 flex justify-between text-[11px] font-semibold text-slate-400"><span>1 hour</span><span>12 hours</span></div></div>
            </div>
            {error && <div role="alert" aria-live="assertive" className="mb-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"><p className="font-semibold">{error}</p><p className="mt-1 text-xs text-rose-600">Check your details and try again. Your entries are still saved.</p><button type="button" onClick={onGenerate} disabled={isLoading || !canSubmit} className="mt-2 text-xs font-bold text-rose-700 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50">Retry generation</button></div>}
            <button type="submit" disabled={isLoading || !canSubmit} aria-busy={isLoading} className="primary-button w-full">{isLoading ? <><Loader2 className="animate-spin" size={18} /> Building your roadmap...</> : <>Generate Study Strategy <ArrowRight size={18} /> </>}</button>
            {isLoading && <div role="status" aria-live="polite" className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-violet-50 px-3 py-2.5 text-xs font-semibold text-violet-700"><span className="size-1.5 animate-pulse rounded-full bg-violet-600" /> Organizing your topics around your available time...</div>}
            <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-slate-400"><Sparkles size={12} /> Your plan is ready in under a minute</p>
          </form>
        </section>
      </div>
    </main>
  );
}

function DashboardView({
  roadmap,
  stats,
  activeDay,
  expandedDays,
  isRebalancing,
  notice,
  rebalancingError,
  examDate,
  onToggleDay,
  onToggleTopic,
  onRebalance,
  onNewStrategy,
}: {
  roadmap: RoadmapDay[];
  stats: { total: number; completed: number; percentage: number; streak: number };
  activeDay?: RoadmapDay;
  expandedDays: number[];
  isRebalancing: boolean;
  notice: string;
  rebalancingError: string;
  examDate: string;
  onToggleDay: (day: number) => void;
  onToggleTopic: (day: number, id: string) => void;
  onRebalance: () => void;
  onNewStrategy: () => void;
}) {
  const daysUntilExam = getDaysUntil(examDate);
  const today = getTodayString();
  const todayDay = roadmap.find((day) => day.date === today);
  const plannedMinutes = todayDay
    ? getDayTasks(todayDay).reduce((sum, topic) => sum + topic.estimatedMinutes, 0)
    : 0;

  return (
    <div className="page-enter">
      <nav className="print-hidden mb-8 flex items-center justify-between border-b pb-4">
        <div className="flex gap-5 text-sm font-semibold text-slate-500">
          <a href="#overview" className="text-violet-600">Dashboard</a>
          <a href="#roadmap" className="transition-colors hover:text-violet-600">My Roadmap</a>
          <a href="#progress" className="transition-colors hover:text-violet-600">Progress</a>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={() => window.print()} className="secondary-button"><Printer size={16} /> Export to PDF</button>
          <button onClick={() => downloadRoadmapCalendar(roadmap)} className="secondary-button"><Download size={16} /> Add to Calendar</button>
          <button onClick={onNewStrategy} className="secondary-button"><Sparkles size={16} /> New strategy</button>
        </div>
      </nav>
      <div id="overview" className="print-hidden mb-9 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="eyebrow">Dashboard</p><h2 className="mt-2 text-3xl font-black tracking-[-0.03em] sm:text-4xl">Keep the momentum.</h2><p className="mt-2 text-sm text-slate-500">One focused session at a time.</p></div>{examDate && <p className="text-sm font-semibold text-slate-500">Exam target: <span className="text-slate-900">{formatDate(examDate)}</span></p>}</div>
      <div className="print-hidden"><AnalyticsSummary stats={stats} /></div>
      <div className="print-hidden grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={<Target size={18} />} label="Exam countdown" value={daysUntilExam === null ? "—" : daysUntilExam >= 0 ? `${daysUntilExam} days` : "Past due"} detail={examDate ? formatDate(examDate) : "Target not saved"} color="indigo" />
        <StatCard icon={<BarChart3 size={18} />} label="Total tasks" value={stats.total} detail="in your roadmap" color="indigo" />
        <StatCard icon={<Check size={18} />} label="Completed" value={stats.completed} detail={`${stats.percentage}% complete`} color="emerald" />
        <StatCard icon={<TrendingUp size={18} />} label="Remaining" value={Math.max(stats.total - stats.completed, 0)} detail="topics to go" color="orange" />
        <StatCard icon={<Clock3 size={18} />} label="Today planned" value={formatMinutes(plannedMinutes)} detail={todayDay ? `${getDayTasks(todayDay).length} tasks today` : "No tasks today"} color="violet" />
      </div>
      <div id="progress" className="print-hidden surface-card mt-5 p-5"><div className="mb-3 flex justify-between text-sm font-bold"><span>Overall completion</span><span className="text-violet-600">{stats.percentage}%</span></div><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="progress-fill h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-all duration-500" style={{ width: `${stats.percentage}%` }} /></div></div>
      <div id="roadmap" className="printable-roadmap mt-10 grid gap-8 xl:grid-cols-[1fr_300px]">
        <section><div className="mb-4 flex items-center justify-between"><div><h3 className="text-xl font-bold tracking-tight">Daily checklist</h3><p className="mt-1 text-sm text-slate-500">{roadmap.length} planned study days</p></div><CalendarDays className="text-slate-400" size={20} aria-label="Calendar" /></div>{roadmap.length === 0 ? <EmptyRoadmap onNewStrategy={onNewStrategy} /> : <div className="space-y-3">{roadmap.map((day) => <DayAccordion key={day.day} day={day} expanded={expandedDays.includes(day.day)} isToday={day.date === today} onToggle={() => onToggleDay(day.day)} onTopicToggle={onToggleTopic} />)}</div>}</section>
        <aside className="print-hidden space-y-4"><FocusTimer /><div className="overflow-hidden rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-600 to-indigo-600 p-5 text-white shadow-xl shadow-violet-200"><div className="mb-7 flex items-start justify-between"><div><p className="text-sm font-semibold text-violet-100">Today&apos;s focus</p><p className="mt-1 text-2xl font-black">{todayDay ? `Day ${todayDay.day}` : activeDay ? `Day ${activeDay.day}` : "Ready"}</p></div><div className="rounded-xl bg-white/15 p-2.5"><Target size={20} /></div></div><p className="text-sm text-violet-100">{todayDay ? formatDate(todayDay.date) : "No schedule for today"}</p><div className="mt-4 flex items-center gap-2 text-sm font-semibold"><Clock3 size={15} /> {formatMinutes(plannedMinutes)} planned</div></div><div className="surface-card p-5"><div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><RefreshCw size={18} /></div><h3 className="font-bold">Fell behind?</h3><p className="mt-1 text-sm leading-6 text-slate-500">Redistribute unfinished topics while preserving completed work and your exam date.</p><button onClick={onRebalance} disabled={isRebalancing || roadmap.length === 0} className="secondary-button mt-4 w-full justify-center text-xs">{isRebalancing ? <><Loader2 className="animate-spin" size={15} /> Rebalancing...</> : <><RefreshCw size={15} /> I&apos;m Behind — Rebalance My Plan</>}</button>{notice && <p role="status" className="mt-3 text-xs font-semibold text-emerald-600">{notice}</p>}{rebalancingError && <p role="alert" className="mt-3 text-xs font-semibold text-rose-600">{rebalancingError}</p>}</div></aside>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, detail, color }: { icon: ReactNode; label: string; value: string | number; detail: string; color: string }) {
  const colorClasses = {
    indigo: "bg-violet-50 text-violet-600",
    emerald: "bg-emerald-50 text-emerald-600",
    orange: "bg-orange-50 text-orange-600",
    violet: "bg-violet-50 text-violet-600",
  };
  return <div className="surface-card p-5 transition-transform duration-200 hover:-translate-y-0.5"><div className={`mb-5 flex size-9 items-center justify-center rounded-xl ${colorClasses[color as keyof typeof colorClasses]}`}>{icon}</div><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-1 text-2xl font-black tracking-tight">{value}</p><p className="mt-1 text-xs text-slate-400">{detail}</p></div>;
}

function AnalyticsSummary({
  stats,
}: {
  stats: { total: number; completed: number; percentage: number; streak: number };
}) {
  return (
    <section className="mb-6 overflow-hidden rounded-3xl bg-gradient-to-br from-violet-600 via-indigo-600 to-slate-950 p-5 text-white shadow-xl shadow-violet-200/60 sm:p-7" aria-label="Study analytics summary">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-violet-100">
            <BarChart3 size={17} />
            <span>Study analytics</span>
          </div>
          <h3 className="mt-2 text-2xl font-black tracking-tight">Your momentum at a glance</h3>
          <p className="mt-1 text-sm text-indigo-100">Keep showing up and let the progress compound.</p>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:gap-6">
          <AnalyticsMetric label="Completion" value={`${stats.percentage}%`} />
          <AnalyticsMetric label="Streak" value={`${stats.streak} ${stats.streak === 1 ? "day" : "days"}`} icon={<Flame size={15} />} />
          <AnalyticsMetric label="Tasks finished" value={stats.completed} />
        </div>
      </div>
      <div className="mt-6">
        <div className="mb-2 flex justify-between text-xs font-bold text-indigo-100">
          <span>{stats.completed} of {stats.total} tasks finished</span>
          <span>{stats.percentage}%</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuenow={stats.percentage} aria-valuemin={0} aria-valuemax={100} aria-label="Overall syllabus completion">
          <div className="h-full rounded-full bg-gradient-to-r from-white to-violet-200 transition-all duration-500" style={{ width: `${stats.percentage}%` }} />
        </div>
      </div>
    </section>
  );
}

function AnalyticsMetric({ label, value, icon }: { label: string; value: string | number; icon?: ReactNode }) {
  return (
    <div className="min-w-0 border-l border-white/20 pl-3 sm:pl-6">
      <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-indigo-200">{icon}{label}</p>
      <p className="mt-1 whitespace-nowrap text-xl font-black sm:text-2xl">{value}</p>
    </div>
  );
}

type TimerMode = "work" | "break";

function playTimerChime() {
  if (typeof window === "undefined") return;

  try {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.45);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.45);
    oscillator.addEventListener("ended", () => void audioContext.close(), { once: true });
  } catch {
    // Audio is optional and may be unavailable in some browsers.
  }
}

function FocusTimer() {
  const [mode, setMode] = useState<TimerMode>("work");
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!isRunning) return undefined;

    const interval = window.setInterval(() => {
      setTimeLeft((currentTime) => {
        if (currentTime > 1) return currentTime - 1;

        playTimerChime();
        setIsRunning(false);
        setMode((currentMode) => {
          const nextMode = currentMode === "work" ? "break" : "work";
          setTimeLeft(nextMode === "work" ? 25 * 60 : 5 * 60);
          return nextMode;
        });
        return 0;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isRunning]);

  function selectMode(nextMode: TimerMode) {
    setIsRunning(false);
    setMode(nextMode);
    setTimeLeft(nextMode === "work" ? 25 * 60 : 5 * 60);
  }

  function resetTimer() {
    setIsRunning(false);
    setTimeLeft(mode === "work" ? 25 * 60 : 5 * 60);
  }

  const minutes = Math.floor(timeLeft / 60).toString().padStart(2, "0");
  const seconds = (timeLeft % 60).toString().padStart(2, "0");

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950 p-5 text-white shadow-xl shadow-indigo-200/20" aria-label="Pomodoro focus timer">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-300">Focus timer</p>
          <h3 className="mt-1 text-lg font-black">Lock in your next session</h3>
        </div>
        <Clock3 className="text-violet-300" size={20} />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl bg-slate-900 p-1">
        {(["work", "break"] as const).map((timerMode) => (
          <button
            key={timerMode}
            type="button"
            onClick={() => selectMode(timerMode)}
            className={`rounded-lg px-3 py-2 text-xs font-bold capitalize transition-colors ${mode === timerMode ? "bg-violet-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}
          >
            {timerMode === "work" ? "25 min work" : "5 min break"}
          </button>
        ))}
      </div>
      <div className="py-6 text-center">
        <p className="font-mono text-6xl font-black tracking-tight text-white" aria-live="polite">
          {minutes}:{seconds}
        </p>
        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          {isRunning ? `${mode} session in progress` : `${mode} session paused`}
        </p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => setIsRunning((running) => !running)} className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-500 px-3 text-sm font-bold text-white transition-colors hover:bg-violet-400">
          {isRunning ? <><Pause size={15} /> Pause</> : <><Play size={15} /> Start</>}
        </button>
        <button type="button" onClick={resetTimer} aria-label="Reset timer" className="flex h-10 items-center justify-center rounded-xl border border-slate-700 px-3 text-slate-300 transition-colors hover:bg-slate-800 hover:text-white">
          <RotateCcw size={16} />
        </button>
      </div>
      <p className="mt-3 text-center text-[11px] text-slate-500">A chime plays when the session ends.</p>
    </section>
  );
}

function EmptyRoadmap({ onNewStrategy }: { onNewStrategy: () => void }) {
  return <div className="surface-card flex flex-col items-center px-6 py-14 text-center"><div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-600"><CalendarDays size={22} /></div><h4 className="text-lg font-bold">Your roadmap is empty</h4><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Generate a strategy to turn your syllabus into focused daily checklists.</p><button onClick={onNewStrategy} className="primary-button mt-6">Create a strategy <ArrowRight size={16} /></button></div>;
}

function DayAccordion({ day, expanded, isToday, onToggle, onTopicToggle }: { day: RoadmapDay; expanded: boolean; isToday: boolean; onToggle: () => void; onTopicToggle: (day: number, id: string) => void }) {
  const tasks = getDayTasks(day);
  const completed = tasks.filter((task) => task.completed).length;
  return <div className={`overflow-hidden rounded-2xl border bg-white transition-all duration-200 ${isToday ? "border-violet-300 ring-2 ring-violet-100" : ""} ${expanded ? "shadow-md shadow-violet-100/50" : "shadow-[0_6px_20px_rgb(16_17_36_/3%)] hover:border-violet-100"}`}>
    <button onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-4 p-4 text-left sm:p-5">
      <div className={`flex size-11 shrink-0 flex-col items-center justify-center rounded-xl ${completed === tasks.length && tasks.length > 0 ? "bg-emerald-50 text-emerald-600" : "bg-violet-50 text-violet-600"}`}><span className="text-[10px] font-bold uppercase">Day</span><span className="text-lg font-black leading-4">{day.day}</span></div>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-bold">{formatDate(day.date)}</p>{isToday && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-700">Today</span>}{completed === tasks.length && tasks.length > 0 && <Check className="text-emerald-500" size={15} aria-label="Complete" />}</div><p className="mt-1 text-xs text-slate-500">{tasks.length === 0 ? "Rest day" : `${completed} of ${tasks.length} tasks complete`}</p></div>
      <ChevronDown className={`text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`} size={20} />
    </button>
    {expanded && <div className="border-t px-4 pb-4 sm:px-5 sm:pb-5">{tasks.length === 0 ? <p className="pt-4 text-sm text-slate-400">No study tasks planned for this day.</p> : <div className="space-y-5 pt-3">{taskGroups.map(({ key, label }) => <section key={key}><h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{label}</h4><div className="space-y-2">{(day?.[key] ?? []).map((task) => <label key={task.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${task.completed ? "border-emerald-100 bg-emerald-50/60" : "hover:border-violet-100 hover:bg-violet-50/30"}`}><input type="checkbox" checked={task.completed} onChange={() => onTopicToggle(day.day, task.id)} className="peer sr-only" /><span className={`flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${task.completed ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300"}`}>{task.completed && <Check size={13} strokeWidth={3} />}</span><span className="min-w-0 flex-1"><span className={`block text-sm font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-800"}`}>{task.title}</span><span className="mt-1 block text-xs text-slate-400">{task.subject} · {formatMinutes(task.estimatedMinutes)}</span></span><QuickExplainButton topic={task.title} /><span className={`text-[11px] font-semibold ${task.completed ? "text-emerald-600" : "text-slate-400"}`}>{task.completed ? "Done" : "To do"}</span></label>)}</div></section>)}</div>}</div>}
  </div>;
}

function QuickExplainButton({ topic }: { topic: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");

  async function explainTopic() {
    setIsOpen(true);
    setError("");
    if (explanation) return;

    setIsLoading(true);
    try {
      const response = await fetch("/api/explain-topic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const responseText = await response.text();
      let data: { explanation?: string; error?: string } = {};
      try {
        data = JSON.parse(responseText) as { explanation?: string; error?: string };
      } catch {
        throw new Error(
          responseText.trim() || `The explanation service returned HTTP ${response.status}.`,
        );
      }
      if (!response.ok || typeof data.explanation !== "string" || data.explanation.trim().length === 0) {
        throw new Error(data.error || `The explanation service returned HTTP ${response.status}.`);
      }
      setExplanation(data.explanation);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to explain this topic.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Explain ${topic}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void explainTopic();
        }}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] font-bold text-violet-700 transition-colors hover:bg-violet-100"
      >
        <Lightbulb size={13} />
        Explain
      </button>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-5" role="presentation" onClick={() => setIsOpen(false)}>
          <section className="w-full max-w-lg rounded-3xl bg-white p-6 text-left shadow-2xl" role="dialog" aria-modal="true" aria-labelledby={`explain-${topic}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">AI Quick Explain</p>
                <h3 id={`explain-${topic}`} className="mt-1 text-xl font-black text-slate-950">{topic}</h3>
              </div>
              <button type="button" onClick={() => setIsOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close explanation"><X size={20} /></button>
            </div>
            {isLoading && <div className="flex items-center gap-2 py-10 text-sm font-semibold text-slate-500"><Loader2 className="animate-spin text-violet-600" size={18} /> Building a concise explanation...</div>}
            {error && <div className="mt-6 rounded-xl border border-rose-100 bg-rose-50 p-4 text-sm font-semibold text-rose-700" role="alert">{error}<button type="button" onClick={() => void explainTopic()} className="ml-2 underline">Try again</button></div>}
            {explanation && !isLoading && <div className="mt-6 whitespace-pre-line rounded-2xl bg-violet-50 p-4 text-sm leading-7 text-violet-950">{explanation}</div>}
          </section>
        </div>
      )}
    </>
  );
}
