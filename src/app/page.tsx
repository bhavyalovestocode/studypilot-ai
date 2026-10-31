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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";
import {
  calculateProgress,
  getDayTasks,
  isValidStoredRoadmap,
  normalizeRoadmap,
  rebalanceRoadmap,
  taskGroups,
  type RoadmapDay,
} from "./roadmap-utils";

const STORAGE_KEY = "studypilot-roadmap";
const EXAM_DATE_STORAGE_KEY = "studypilot-exam-date";
const STREAK_STORAGE_KEY = "studypilot-streak";
const SETUP_DRAFT_STORAGE_KEY = "studypilot-setup-draft";
const STORAGE_VERSION = 2;

type StreakRecord = {
  completedDates: string[];
};

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
  const [rebalancePreview, setRebalancePreview] = useState<ReturnType<typeof rebalanceRoadmap> | null>(null);
  const [previousRoadmap, setPreviousRoadmap] = useState<RoadmapDay[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
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
    const storedDraft = window.localStorage.getItem(SETUP_DRAFT_STORAGE_KEY);
    const restoreTimer = window.setTimeout(() => {
      if (storedExamDate) setExamDate(storedExamDate);
      if (storedDraft) {
        try {
          const draft = JSON.parse(storedDraft) as {
            syllabusText?: unknown;
            examDate?: unknown;
            dailyHours?: unknown;
          };
          if (typeof draft.syllabusText === "string") setSyllabusText(draft.syllabusText);
          if (!storedExamDate && typeof draft.examDate === "string") setExamDate(draft.examDate);
          if (typeof draft.dailyHours === "number" && Number.isFinite(draft.dailyHours)) {
            setDailyHours(Math.min(12, Math.max(1, draft.dailyHours)));
          }
        } catch {
          window.localStorage.removeItem(SETUP_DRAFT_STORAGE_KEY);
        }
      }
      if (storedRoadmap) {
        try {
          const parsed = JSON.parse(storedRoadmap) as { version?: number; roadmap?: unknown } | unknown;
          const candidate = parsed && typeof parsed === "object" && "roadmap" in parsed
            ? parsed.roadmap
            : parsed;
          const saved = normalizeRoadmap(candidate);
          if (isValidStoredRoadmap(saved)) {
            setRoadmap(saved);
            setView("dashboard");
          } else {
            window.localStorage.removeItem(STORAGE_KEY);
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
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, roadmap }));
      } catch {
        window.setTimeout(
          () => setNotice("Your progress is only stored for this session because browser storage is unavailable."),
          0,
        );
      }
    }
  }, [roadmap]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SETUP_DRAFT_STORAGE_KEY,
        JSON.stringify({ syllabusText, examDate, dailyHours }),
      );
    } catch {
      // The form remains usable when browser storage is unavailable.
    }
  }, [syllabusText, examDate, dailyHours]);

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

  useEffect(() => {
    if (!mobileNavOpen) {
      mobileNavTriggerRef.current?.focus();
      return undefined;
    }

    mobileNavCloseRef.current?.focus();
    function handleNavigationKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileNavOpen(false);
    }
    window.addEventListener("keydown", handleNavigationKey);
    return () => window.removeEventListener("keydown", handleNavigationKey);
  }, [mobileNavOpen]);

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
      setRoadmap(normalizedRoadmap);
      try {
        window.localStorage.setItem(EXAM_DATE_STORAGE_KEY, examDate);
      } catch {
        setNotice("Your roadmap is ready, but browser storage is unavailable. Keep this tab open to retain progress.");
      }
      setExpandedDays([1]);
      setRebalancePreview(null);
      setPreviousRoadmap(null);
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
    setNotice("");
    setRebalancePreview(rebalanceRoadmap(roadmap, dailyHours, getTodayString()));
  }

  function applyRebalance() {
    if (!rebalancePreview?.isFeasible) return;
    setPreviousRoadmap(roadmap);
    setRoadmap(rebalancePreview.proposedRoadmap);
    setRebalancePreview(null);
    setNotice(`Redistributed ${rebalancePreview.movedTaskIds.length} unfinished tasks within your daily limit.`);
  }

  function cancelRebalance() {
    setRebalancePreview(null);
  }

  function undoRebalance() {
    if (!previousRoadmap) return;
    setRoadmap(previousRoadmap);
    setPreviousRoadmap(null);
    setNotice("Your previous schedule has been restored.");
  }

  const activeDay = roadmap[0];

  if (view === "setup") {
    return (
      <ChatOnboarding
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
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200/80 bg-[#f7f7f4]/95 px-5 py-7 shadow-[8px_0_30px_rgb(16_17_36_/3%)] backdrop-blur lg:flex dark:border-slate-800 dark:bg-slate-950/95">
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
        <div className="mt-auto rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-slate-950 text-white shadow-lg shadow-slate-300/30 dark:bg-violet-600">
            <Target size={18} />
          </div>
          <p className="text-sm font-semibold text-slate-950 dark:text-white">Small steps, big wins.</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Consistency compounds. You&apos;ve got this.</p>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-20 items-center justify-between border-b border-slate-200/80 bg-[#f7f7f4]/85 px-5 backdrop-blur-xl sm:px-8 lg:px-12 dark:border-slate-800 dark:bg-slate-950/85">
          <button ref={mobileNavTriggerRef} className="flex items-center gap-2 lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation menu" aria-expanded={mobileNavOpen}>
            <Menu size={20} />
            <Brand />
          </button>
          <div className="hidden lg:block">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Your learning workspace</p>
            <h1 className="mt-1 text-lg font-bold tracking-tight">Good to see you again</h1>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <div className="hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm sm:flex dark:border-slate-800 dark:bg-slate-900">
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
              rebalancePreview={rebalancePreview}
              canUndoRebalance={Boolean(previousRoadmap)}
              notice={notice}
              examDate={examDate}
              onToggleDay={toggleDay}
              onToggleTopic={toggleTopic}
              onRebalance={rebalancePlan}
              onApplyRebalance={applyRebalance}
              onCancelRebalance={cancelRebalance}
              onUndoRebalance={undoRebalance}
              onNewStrategy={() => setView("setup")}
            />
        </main>
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/30 lg:hidden" onClick={() => setMobileNavOpen(false)}>
          <div className="h-full w-72 border-r border-slate-200 bg-[#f7f7f4] p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-950" role="dialog" aria-modal="true" aria-labelledby="mobile-navigation-title" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between"><span id="mobile-navigation-title" className="sr-only">Mobile navigation</span><Brand /><button ref={mobileNavCloseRef} onClick={() => setMobileNavOpen(false)} aria-label="Close navigation menu"><X size={20} /></button></div>
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
  return <div className="flex items-center gap-2.5"><div className="flex size-9 items-center justify-center rounded-xl bg-slate-950 text-white shadow-lg shadow-slate-300/40"><GraduationCap size={18} /></div><span className="text-base font-extrabold tracking-tight text-slate-950">StudyPilot<span className="text-violet-600"> AI</span></span></div>;
}

function ChatOnboarding({
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
    const timer = window.setTimeout(() => setToday(new Date().toISOString().slice(0, 10)), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const dateError = today.length > 0 && examDate.length > 0 && examDate < today;
  const canSubmit = syllabusText.trim().length > 0 && Boolean(examDate) && !dateError;

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit && !isLoading) onGenerate();
    }
  }

  return (
    <main className="min-h-screen bg-canvas text-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-[#f7f7f4]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-6xl items-center justify-between px-5 sm:px-8">
          <a href="#" aria-label="StudyPilot AI home"><Brand /></a>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs font-semibold text-slate-500 sm:inline">New study roadmap</span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-col px-5 pb-28 pt-12 sm:px-8 sm:pt-16">
        <div className="mb-12 text-center animate-fade-up">
          <div className="landing-kicker justify-center"><span className="size-1.5 rounded-full bg-violet-600" /> Guided planning</div>
          <h1 className="mt-5 text-4xl font-black leading-[1.02] tracking-[-0.06em] sm:text-6xl">Let&apos;s build a plan<br /><span className="text-violet-600">that fits your life.</span></h1>
          <p className="mx-auto mt-5 max-w-lg text-sm leading-7 text-slate-500 sm:text-base">I&apos;ll ask for three things, then turn them into a structured roadmap with a clear next step for every study day.</p>
        </div>

        <section className="space-y-7" aria-label="Study plan conversation">
          <div className="flex gap-3 animate-fade-up animation-delay-100">
            <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white"><Sparkles size={15} /></div>
            <div className="max-w-[35rem] rounded-2xl rounded-tl-md border border-slate-200 bg-white px-5 py-4 shadow-[0_8px_24px_rgb(15_23_42_/4%)]">
              <p className="text-sm font-bold text-slate-950">What are you preparing for?</p>
              <p className="mt-1.5 text-sm leading-6 text-slate-500">Share your syllabus, subjects, chapters, or a rough topic list. More detail helps me pace the plan well.</p>
            </div>
          </div>

          <div className="ml-0 sm:ml-11 animate-fade-up animation-delay-200">
            <form onSubmit={(event) => { event.preventDefault(); if (canSubmit && !isLoading) onGenerate(); }} className="space-y-5">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_35px_rgb(16_17_36_/4%)] sm:p-5">
                <div className="mb-3 flex items-center justify-between">
                  <label className="field-label mb-0" htmlFor="syllabus">Your syllabus</label>
                  <span className="text-xs tabular-nums text-slate-400">{syllabusText.length} characters</span>
                </div>
                <textarea
                  id="syllabus"
                  value={syllabusText}
                  onChange={(event) => onSyllabusChange(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={"e.g. Biology: cell structure, genetics, ecology\nMathematics: calculus, probability, statistics"}
                  aria-describedby="syllabus-help"
                  className="input-field min-h-32 resize-y border-0 bg-slate-50/70 px-4 py-4 leading-7 shadow-none focus:bg-white focus:ring-4 focus:ring-violet-500/10"
                />
                <p id="syllabus-help" className="mt-2 text-xs leading-5 text-slate-400">Press Enter to send when everything is ready. Shift + Enter adds a new line.</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgb(15_23_42_/3%)]">
                  <label className="field-label" htmlFor="exam-date">When is your exam?</label>
                  <div className="relative"><CalendarDays className="input-icon" size={17} /><input id="exam-date" type="date" min={today} value={examDate} onChange={(event) => onDateChange(event.target.value)} aria-invalid={dateError} aria-describedby={dateError ? "date-error" : undefined} className={`input-field pl-10 ${dateError ? "border-rose-300 focus:border-rose-500 focus:ring-rose-500/10" : ""}`} /></div>
                  {dateError && <p id="date-error" role="alert" className="mt-2 text-xs font-semibold text-rose-600">Choose today or a future date.</p>}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgb(15_23_42_/3%)]">
                  <div className="mb-3 flex items-end justify-between"><label className="field-label mb-0" htmlFor="hours">Daily availability</label><span className="text-lg font-black tracking-tight text-violet-600">{dailyHours}<span className="ml-1 text-xs font-bold">hrs</span></span></div>
                  <input id="hours" type="range" min="1" max="12" step="0.5" value={dailyHours} onChange={(event) => onHoursChange(Number(event.target.value))} aria-valuetext={`${dailyHours} hours per day`} aria-describedby="hours-help" className="mt-2 w-full cursor-pointer accent-violet-600" />
                  <div className="mt-2 flex justify-between text-[11px] font-semibold text-slate-400"><span>1 hour</span><span>12 hours</span></div>
                  <p id="hours-help" className="mt-2 text-xs leading-5 text-slate-400">Up to {dailyHours * 60} minutes per study day.</p>
                </div>
              </div>

              {error && <div role="alert" aria-live="assertive" className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"><p className="font-semibold">{error}</p><p className="mt-1 text-xs text-rose-600">Your entries are still saved. Check the details and try again.</p><button type="button" onClick={onGenerate} disabled={isLoading || !canSubmit} className="mt-2 text-xs font-bold text-rose-700 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50">Retry generation</button></div>}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <button type="submit" disabled={isLoading || !canSubmit} aria-busy={isLoading} className="landing-button landing-button-primary w-full sm:flex-1">{isLoading ? <><Loader2 className="animate-spin" size={17} /> Building your roadmap...</> : <>Create my roadmap <ArrowRight size={17} /></>}</button>
                <span className="text-center text-xs text-slate-400 sm:max-w-[12rem] sm:text-left">No account needed. Your plan stays in this browser.</span>
              </div>
              {isLoading && <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 rounded-xl bg-violet-50 px-3 py-3 text-xs font-semibold text-violet-700"><span className="size-1.5 animate-pulse rounded-full bg-violet-600" /> Organizing your topics around your available time...</div>}
            </form>
          </div>

          <div className="flex gap-3 border-t border-slate-200 pt-7 animate-fade-up animation-delay-300">
            <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Check size={15} /></div>
            <div><p className="text-sm font-bold text-slate-950">What you&apos;ll get</p><p className="mt-1 text-sm leading-6 text-slate-500">A dated checklist split into theory, exercises, and active practice, validated against your time and exam date.</p></div>
          </div>
        </section>
      </div>
    </main>
  );
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navElevated, setNavElevated] = useState(false);
  useEffect(() => {
    const todayTimer = window.setTimeout(() => {
      setToday(new Date().toISOString().slice(0, 10));
    }, 0);
    const handleScroll = () => setNavElevated(window.scrollY > 12);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.clearTimeout(todayTimer);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const dateError = today.length > 0 && examDate.length > 0 && examDate < today;
  const canSubmit = syllabusText.trim().length > 0 && Boolean(examDate) && !dateError;
  const scrollToPlanner = () => {
    setMobileMenuOpen(false);
    document.getElementById("planner")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => document.getElementById("syllabus")?.focus(), 450);
  };

  return (
    <main className="page-enter min-h-screen overflow-hidden bg-canvas text-slate-950">
      <header className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${navElevated ? "border-b border-slate-200/80 bg-[#f7f7f4]/90 shadow-[0_8px_30px_rgb(15_23_42_/5%)] backdrop-blur-xl" : "bg-transparent"}`}>
        <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-12">
          <a href="#" aria-label="StudyPilot AI home"><Brand /></a>
          <nav className="hidden items-center gap-8 md:flex" aria-label="Main navigation">
            <a className="landing-nav-link" href="#product">Product</a>
            <a className="landing-nav-link" href="#features">Features</a>
            <a className="landing-nav-link" href="#how-it-works">How it works</a>
            <a className="landing-nav-link" href="#faq">FAQ</a>
          </nav>
          <div className="hidden items-center gap-3 md:flex"><ThemeToggle /><button type="button" onClick={scrollToPlanner} className="landing-button landing-button-dark">Build my study plan <ArrowRight size={15} /></button></div>
          <div className="flex items-center gap-2 md:hidden"><ThemeToggle /><button type="button" onClick={() => setMobileMenuOpen((open) => !open)} className="flex size-10 items-center justify-center rounded-xl border border-slate-200 bg-white" aria-expanded={mobileMenuOpen} aria-label="Toggle navigation"><Menu size={19} /></button></div>
        </div>
        {mobileMenuOpen && <div className="border-t border-slate-200 bg-[#f7f7f4] px-5 py-5 md:hidden"><nav className="grid gap-1" aria-label="Mobile navigation">{[["Product", "#product"], ["Features", "#features"], ["How it works", "#how-it-works"], ["FAQ", "#faq"]].map(([label, href]) => <a key={href} href={href} onClick={() => setMobileMenuOpen(false)} className="rounded-lg px-3 py-3 text-sm font-semibold text-slate-600 hover:bg-white hover:text-slate-950">{label}</a>)}<button type="button" onClick={scrollToPlanner} className="landing-button landing-button-dark mt-3 w-full">Build my study plan <ArrowRight size={15} /></button></nav></div>}
      </header>

      <section id="product" className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-32 sm:px-8 sm:pt-40 lg:grid-cols-[0.88fr_1.12fr] lg:gap-20 lg:px-12 lg:pb-28">
        <div className="pointer-events-none absolute -right-56 -top-24 size-[34rem] rounded-full bg-violet-200/25 blur-3xl" />
        <div className="relative">
          <div className="landing-kicker animate-fade-up"><span className="size-1.5 rounded-full bg-violet-600" /> A calmer way to prepare</div>
          <h1 className="animate-fade-up animation-delay-100 mt-7 max-w-2xl text-[clamp(3.35rem,7vw,6.8rem)] font-black leading-[0.91] tracking-[-0.075em] text-slate-950">Your syllabus.<br />Your schedule.<br /><span className="text-violet-600">Your next breakthrough.</span></h1>
          <p className="animate-fade-up animation-delay-200 mt-8 max-w-lg text-base leading-7 text-slate-600 sm:text-lg sm:leading-8">Turn your syllabus, exam date, and available study hours into an intelligent study roadmap that adapts when life gets in the way.</p>
          <div className="animate-fade-up animation-delay-300 mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center"><button type="button" onClick={scrollToPlanner} className="landing-button landing-button-primary">Build my study plan <ArrowRight size={16} /></button><a href="#how-it-works" className="inline-flex items-center gap-2 px-1 text-sm font-bold text-slate-600 transition-colors hover:text-violet-600">Explore how it works <span aria-hidden="true">↘</span></a></div>
          <div className="mt-12 flex flex-wrap gap-x-7 gap-y-3 border-t border-slate-200 pt-5 text-xs font-semibold text-slate-500"><span className="flex items-center gap-2"><Check size={14} className="text-violet-600" /> Built around your exam</span><span className="flex items-center gap-2"><Check size={14} className="text-violet-600" /> Saved in your browser</span></div>
        </div>
        <ProductPreview />
      </section>

      <section className="border-y border-slate-200 bg-white/70">
        <div className="mx-auto grid max-w-7xl gap-0 px-5 sm:px-8 md:grid-cols-3 lg:px-12">
          {[["01", "Structured preparation", "A clear path from the full syllabus to the next right task."], ["02", "Adaptive scheduling", "A plan that can make room when your week does not go to plan."], ["03", "Progress visibility", "A focused view of what is done, what is next, and what matters."]].map(([number, title, detail]) => <div key={number} className="flex gap-4 border-b border-slate-200 py-7 last:border-0 md:border-b-0 md:border-r md:px-8 md:first:pl-0 md:last:border-r-0"><span className="font-mono text-xs font-bold text-violet-600">{number}</span><div><h2 className="text-sm font-bold text-slate-950">{title}</h2><p className="mt-1.5 max-w-xs text-sm leading-6 text-slate-500">{detail}</p></div></div>)}
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-12 px-5 py-24 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:px-12 lg:py-36">
        <div><p className="eyebrow">The problem</p><h2 className="mt-4 max-w-md text-4xl font-black leading-[1.02] tracking-[-0.055em] sm:text-5xl">Studying is hard enough. Planning shouldn&apos;t be.</h2></div>
        <div className="grid gap-8 sm:grid-cols-2">{[["01", "The syllabus is a wall of words.", "Important topics hide in a long list, making it hard to know where to begin."], ["02", "Every day starts with a decision.", "Without a priority, valuable energy disappears before the real work starts."], ["03", "One missed day becomes a spiral.", "A plan that cannot bend turns a difficult week into a lost one."], ["04", "Progress is difficult to feel.", "Scattered notes and half-finished sessions make momentum invisible."]].map(([number, title, detail]) => <div key={number} className="border-t border-slate-200 pt-5"><span className="font-mono text-xs font-bold text-violet-600">{number}</span><h3 className="mt-3 text-lg font-bold tracking-tight">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{detail}</p></div>)}</div>
      </section>

      <section id="features" className="bg-slate-950 px-5 py-24 text-white sm:px-8 lg:px-12 lg:py-32">
        <div className="mx-auto max-w-7xl"><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-300">One system, five useful surfaces</p><h2 className="mt-4 text-4xl font-black leading-[1.03] tracking-[-0.055em] sm:text-5xl">Everything you need to move from intention to done.</h2></div><div className="mt-16 grid gap-px overflow-hidden border border-white/10 bg-white/10 md:grid-cols-2 lg:grid-cols-3">{([{ number: "01", title: "AI-powered roadmap", detail: "A structured plan generated from the topics you actually need to learn.", icon: <Sparkles size={18} /> }, { number: "02", title: "Daily task breakdown", detail: "Theory, exercises, and active practice, paced into a realistic study day.", icon: <Check size={18} /> }, { number: "03", title: "Progress tracking", detail: "A simple dashboard that makes completed work and next steps visible.", icon: <BarChart3 size={18} /> }, { number: "04", title: "Intelligent rebalancing", detail: "Preview how unfinished work can move across the days you have left.", icon: <RefreshCw size={18} /> }, { number: "05", title: "Exam-oriented preparation", detail: "A dated roadmap that keeps the target in view without adding noise.", icon: <Target size={18} /> }] as Array<{ number: string; title: string; detail: string; icon: ReactNode }>).map((feature) => <article key={feature.number} className="group min-h-56 bg-slate-950 p-7 transition-colors hover:bg-slate-900 sm:p-9"><div className="flex items-start justify-between"><span className="font-mono text-xs text-violet-300">{feature.number}</span><span className="text-violet-300 transition-transform duration-300 group-hover:translate-x-1">{feature.icon}</span></div><h3 className="mt-16 text-xl font-bold tracking-tight">{feature.title}</h3><p className="mt-2 max-w-xs text-sm leading-6 text-slate-400">{feature.detail}</p></article>)}</div></div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:px-12 lg:py-32"><div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]"><div><p className="eyebrow">How it works</p><h2 className="mt-4 max-w-sm text-4xl font-black leading-[1.03] tracking-[-0.055em] sm:text-5xl">A better plan in three moves.</h2><p className="mt-5 max-w-sm text-sm leading-7 text-slate-500">No account maze. No blank calendar. Just the information needed to build a useful first version of your study plan.</p></div><div className="grid gap-0 sm:grid-cols-3">{[["01", "Add your syllabus", "Paste subjects, chapters, or a full outline."], ["02", "Set your constraints", "Choose the exam date and a daily availability you can sustain."], ["03", "Start with today", "Get a dated roadmap, then check off the next task."]].map(([number, title, detail]) => <div key={number} className="border-t border-slate-200 py-6 sm:border-l sm:border-t-0 sm:px-7 first:sm:border-l-0 first:sm:pl-0"><span className="font-mono text-xs font-bold text-violet-600">{number}</span><h3 className="mt-8 text-xl font-bold tracking-tight">{title}</h3><p className="mt-3 text-sm leading-6 text-slate-500">{detail}</p></div>)}</div></div></section>

      <section id="planner" className="relative border-y border-slate-200 bg-[#eeedf7] px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
        <div className="pointer-events-none absolute right-0 top-0 size-80 rounded-full bg-violet-200/50 blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl items-start gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-24">
          <div className="lg:sticky lg:top-28"><p className="eyebrow">Start here</p><h2 className="mt-4 max-w-md text-4xl font-black leading-[1.02] tracking-[-0.055em] sm:text-5xl">Make a plan you can actually keep.</h2><p className="mt-5 max-w-md text-sm leading-7 text-slate-600">Give StudyPilot the shape of your semester. It will turn that context into a focused, dated roadmap.</p><div className="mt-8 grid gap-3 text-sm font-semibold text-slate-700"><span className="flex items-center gap-3"><span className="flex size-7 items-center justify-center rounded-full bg-white text-violet-600 shadow-sm">1</span> Paste the topics you need to cover</span><span className="flex items-center gap-3"><span className="flex size-7 items-center justify-center rounded-full bg-white text-violet-600 shadow-sm">2</span> Choose the day you want to be ready</span><span className="flex items-center gap-3"><span className="flex size-7 items-center justify-center rounded-full bg-white text-violet-600 shadow-sm">3</span> Set a sustainable daily limit</span></div></div>
          <section className="surface-card p-6 sm:p-9">
            <div className="mb-8 flex items-start justify-between gap-5"><div><p className="text-2xl font-black tracking-tight text-slate-950">Build your study plan</p><p className="mt-2 text-sm leading-6 text-slate-500">A few details are all it takes to get started.</p></div><div className="hidden size-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600 sm:flex"><Target size={18} /></div></div>
          <form onSubmit={(event) => { event.preventDefault(); if (canSubmit && !isLoading) onGenerate(); }}>
            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between"><label className="field-label mb-0" htmlFor="syllabus">Syllabus or topics</label><span className="text-xs tabular-nums text-slate-400">{syllabusText.length} characters</span></div>
              <textarea id="syllabus" value={syllabusText} onChange={(event) => onSyllabusChange(event.target.value)} placeholder={"e.g. Biology: cell structure, genetics, ecology\nMathematics: calculus, probability, statistics"} aria-describedby="syllabus-help" className="input-field min-h-44 resize-y leading-7" />
              <p id="syllabus-help" className="mt-2 text-xs text-slate-400">Paste subjects, chapters, or a full syllabus outline. One topic per line works best; include detail such as “cell structure” instead of only “Biology”.</p>
            </div>
            <div className="mb-6">
              <label className="field-label" htmlFor="exam-date">Exam target date</label>
              <div className="relative"><CalendarDays className="input-icon" size={17} /><input id="exam-date" type="date" min={today} value={examDate} onChange={(event) => onDateChange(event.target.value)} aria-invalid={dateError} aria-describedby={dateError ? "date-error" : undefined} className={`input-field pl-10 ${dateError ? "border-rose-300 focus:border-rose-500 focus:ring-rose-500/10" : ""}`} /></div>
              {dateError && <p id="date-error" role="alert" className="mt-2 text-xs font-semibold text-rose-600">Choose today or a future date.</p>}
            </div>
            <div className="mb-7">
              <div className="mb-3 flex items-end justify-between"><label className="field-label mb-0" htmlFor="hours">Daily study hours</label><span className="text-2xl font-black tracking-tight text-violet-600">{dailyHours}<span className="ml-1 text-sm font-bold">hrs/day</span></span></div>
              <div className="rounded-xl border bg-slate-50/70 px-4 py-3"><input id="hours" type="range" min="1" max="12" step="0.5" value={dailyHours} onChange={(event) => onHoursChange(Number(event.target.value))} aria-valuetext={`${dailyHours} hours per day`} aria-describedby="hours-help" className="w-full cursor-pointer accent-violet-600" /><div className="mt-2 flex justify-between text-[11px] font-semibold text-slate-400"><span>1 hour</span><span>12 hours</span></div></div>
              <p id="hours-help" className="mt-2 text-xs text-slate-400">The roadmap will target up to {dailyHours * 60} minutes of work per study day, including theory, exercises, and practice.</p>
            </div>
            {error && <div role="alert" aria-live="assertive" className="mb-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"><p className="font-semibold">{error}</p><p className="mt-1 text-xs text-rose-600">Check your details and try again. Your entries are still saved.</p><button type="button" onClick={onGenerate} disabled={isLoading || !canSubmit} className="mt-2 text-xs font-bold text-rose-700 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50">Retry generation</button></div>}
            <button type="submit" disabled={isLoading || !canSubmit} aria-busy={isLoading} className="primary-button w-full">{isLoading ? <><Loader2 className="animate-spin" size={18} /> Building your roadmap...</> : <>Generate Study Strategy <ArrowRight size={18} /> </>}</button>
            {isLoading && <div role="status" aria-live="polite" className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-violet-50 px-3 py-2.5 text-xs font-semibold text-violet-700"><span className="size-1.5 animate-pulse rounded-full bg-violet-600" /> Organizing your topics around your available time...</div>}
            <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-slate-400"><Sparkles size={12} /> After generation, you&apos;ll get a dated checklist you can save locally and adjust when life changes.</p>
          </form>
          </section>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-4xl px-5 py-24 sm:px-8 lg:py-32"><div className="text-center"><p className="eyebrow">FAQ</p><h2 className="mt-4 text-4xl font-black tracking-[-0.055em] sm:text-5xl">A few useful answers.</h2></div><div className="mt-12 divide-y divide-slate-200 border-y border-slate-200">{[["Do I need an account?", "No. Your roadmap and progress are saved locally in this browser. There is no sign-in flow in the current product."], ["What does StudyPilot use to build a plan?", "It uses your syllabus, exam date, and daily study hours to ask the AI provider for a structured roadmap, then validates the dates, task structure, IDs, and daily capacity before showing it."], ["What happens if I fall behind?", "The dashboard includes a rebalance preview that moves unfinished tasks across remaining days without changing your exam date, and lets you apply or undo the change."], ["Can I export my roadmap?", "Yes. Once your roadmap is generated, the dashboard supports calendar export and printing."]].map(([question, answer]) => <details key={question} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-left text-base font-bold tracking-tight marker:hidden">{question}<ChevronDown size={18} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" /></summary><p className="max-w-2xl pt-3 text-sm leading-7 text-slate-500">{answer}</p></details>)}</div></section>

      <footer className="border-t border-slate-200 bg-white px-5 py-10 sm:px-8 lg:px-12"><div className="mx-auto flex max-w-7xl flex-col gap-8 sm:flex-row sm:items-end sm:justify-between"><div><Brand /><p className="mt-4 max-w-xs text-sm leading-6 text-slate-500">A calmer way to turn your syllabus into progress.</p></div><div className="flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold text-slate-500"><a href="#product" className="hover:text-slate-950">Product</a><a href="#features" className="hover:text-slate-950">Features</a><a href="#how-it-works" className="hover:text-slate-950">How it works</a><a href="#faq" className="hover:text-slate-950">FAQ</a></div><p className="text-xs text-slate-400">© 2026 StudyPilot AI</p></div></footer>
    </main>
  );
}

void SetupLanding;

function ProductPreview() {
  const previewTasks: Array<[string, string, boolean]> = [["Review cell structure", "Theory · 45 min", true], ["Complete genetics exercises", "Exercises · 35 min", true], ["Practice inheritance problems", "Practice · 25 min", false]];
  return <div className="animate-fade-up animation-delay-200 relative mx-auto w-full max-w-[650px]"><div className="absolute -inset-4 rounded-[2rem] bg-violet-200/35 blur-2xl" /><div className="relative overflow-hidden rounded-[1.35rem] border border-slate-200 bg-white shadow-[0_30px_90px_rgb(30_27_75_/15%)]"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-lg bg-slate-950 text-white"><GraduationCap size={14} /></span><span className="text-xs font-bold">StudyPilot <span className="text-violet-600">AI</span></span></div><div className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-rose-300" /><span className="size-2 rounded-full bg-amber-300" /><span className="size-2 rounded-full bg-emerald-300" /></div></div><div className="grid gap-0 bg-[#fbfbfa] sm:grid-cols-[150px_1fr]"><aside className="hidden border-r border-slate-100 bg-white p-4 sm:block"><p className="text-[9px] font-bold uppercase tracking-[0.16em] text-slate-400">Workspace</p><div className="mt-5 space-y-2"><div className="flex items-center gap-2 rounded-lg bg-violet-50 px-2.5 py-2 text-[10px] font-bold text-violet-700"><LayoutDashboard size={12} /> Overview</div><div className="flex items-center gap-2 px-2.5 py-2 text-[10px] font-semibold text-slate-400"><Sparkles size={12} /> New strategy</div></div><div className="mt-24 rounded-xl bg-slate-950 p-3 text-white"><Target size={13} className="text-violet-300" /><p className="mt-2 text-[10px] font-bold">Small steps.</p><p className="mt-1 text-[9px] leading-4 text-slate-400">Big wins.</p></div></aside><div className="min-w-0 p-4 sm:p-6"><div className="flex items-end justify-between"><div><p className="text-[9px] font-bold uppercase tracking-[0.16em] text-violet-600">Your learning workspace</p><p className="mt-1 text-lg font-black tracking-tight text-slate-950">Keep the momentum.</p></div><span className="hidden text-[10px] font-semibold text-slate-400 sm:block">Exam target: Jun 18</span></div><div className="mt-5 grid grid-cols-3 gap-2"><div className="rounded-xl border border-slate-100 bg-white p-3"><p className="text-[9px] font-semibold text-slate-400">Countdown</p><p className="mt-1 text-sm font-black text-slate-950">18 days</p></div><div className="rounded-xl border border-slate-100 bg-white p-3"><p className="text-[9px] font-semibold text-slate-400">Completed</p><p className="mt-1 text-sm font-black text-emerald-600">12 / 36</p></div><div className="rounded-xl border border-slate-100 bg-white p-3"><p className="text-[9px] font-semibold text-slate-400">Today</p><p className="mt-1 text-sm font-black text-violet-600">1h 45m</p></div></div><div className="mt-3 rounded-xl border border-slate-100 bg-white p-3"><div className="flex items-center justify-between text-[10px] font-bold"><span>Overall completion</span><span className="text-violet-600">34%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-[34%] rounded-full bg-violet-600" /></div></div><div className="mt-4 rounded-xl border border-violet-200 bg-white p-3 shadow-sm"><div className="flex items-center justify-between"><div><p className="text-xs font-bold text-slate-950">Today · Day 4</p><p className="mt-1 text-[9px] text-slate-400">3 of 3 tasks complete</p></div><span className="rounded-full bg-violet-50 px-2 py-1 text-[9px] font-bold text-violet-600">Focus</span></div><div className="mt-3 space-y-2">{previewTasks.map(([title, detail, done]) => <div key={title} className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${done ? "border-emerald-100 bg-emerald-50/50" : "border-slate-100"}`}><span className={`flex size-4 items-center justify-center rounded border ${done ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300"}`}>{done && <Check size={10} strokeWidth={3} />}</span><span className="min-w-0 flex-1"><span className={`block truncate text-[10px] font-bold ${done ? "text-slate-400 line-through" : "text-slate-700"}`}>{title}</span><span className="block text-[8px] text-slate-400">{detail}</span></span></div>)}</div></div></div></div></div></div>;
}

function DashboardView({
  roadmap,
  stats,
  activeDay,
  expandedDays,
  rebalancePreview,
  canUndoRebalance,
  notice,
  examDate,
  onToggleDay,
  onToggleTopic,
  onRebalance,
  onApplyRebalance,
  onCancelRebalance,
  onUndoRebalance,
  onNewStrategy,
}: {
  roadmap: RoadmapDay[];
  stats: { total: number; completed: number; percentage: number; streak: number };
  activeDay?: RoadmapDay;
  expandedDays: number[];
  rebalancePreview: ReturnType<typeof rebalanceRoadmap> | null;
  canUndoRebalance: boolean;
  notice: string;
  examDate: string;
  onToggleDay: (day: number) => void;
  onToggleTopic: (day: number, id: string) => void;
  onRebalance: () => void;
  onApplyRebalance: () => void;
  onCancelRebalance: () => void;
  onUndoRebalance: () => void;
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
      <nav className="print-hidden mb-10 flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
        <div className="flex gap-5 text-sm font-semibold text-slate-500">
          <a href="#overview" className="text-violet-600">Dashboard</a>
          <a href="#roadmap" className="transition-colors hover:text-violet-600 focus:text-violet-600">My Roadmap</a>
          <a href="#progress" className="transition-colors hover:text-violet-600 focus:text-violet-600">Progress</a>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <button onClick={() => window.print()} className="secondary-button"><Printer size={16} /> Export to PDF</button>
          <button onClick={() => downloadRoadmapCalendar(roadmap)} className="secondary-button"><Download size={16} /> Add to Calendar</button>
          <button onClick={onNewStrategy} className="secondary-button"><Sparkles size={16} /> New strategy</button>
        </div>
      </nav>
      <div id="overview" className="print-hidden mb-9 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="eyebrow">Dashboard</p><h2 className="mt-2 text-3xl font-black tracking-[-0.03em] sm:text-4xl">Keep the momentum.</h2><p className="mt-2 text-sm text-slate-500">One focused session at a time. Progress is saved in this browser, not synced to an account.</p></div>{examDate && <p className="text-sm font-semibold text-slate-500">Exam target: <span className="text-slate-900">{formatDate(examDate)}</span></p>}</div>
      <div className="print-hidden"><AnalyticsSummary stats={stats} /></div>
      <div className="print-hidden grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={<Target size={18} />} label="Exam countdown" value={daysUntilExam === null ? "—" : daysUntilExam >= 0 ? `${daysUntilExam} days` : "Past due"} detail={examDate ? formatDate(examDate) : "Target not saved"} color="indigo" />
        <StatCard icon={<BarChart3 size={18} />} label="Total tasks" value={stats.total} detail="in your roadmap" color="indigo" />
        <StatCard icon={<Check size={18} />} label="Completed" value={stats.completed} detail={`${stats.percentage}% complete`} color="emerald" />
        <StatCard icon={<TrendingUp size={18} />} label="Remaining" value={Math.max(stats.total - stats.completed, 0)} detail="topics to go" color="orange" />
        <StatCard icon={<Clock3 size={18} />} label="Today planned" value={formatMinutes(plannedMinutes)} detail={todayDay ? `${getDayTasks(todayDay).length} tasks today` : "No tasks today"} color="violet" />
      </div>
      <div id="progress" className="print-hidden surface-card mt-5 p-5"><div className="mb-3 flex justify-between text-sm font-bold"><span>Overall completion</span><span className="text-violet-600">{stats.percentage}%</span></div><div className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="progress-fill h-full rounded-full bg-violet-600 transition-all duration-500" style={{ width: `${stats.percentage}%` }} /></div></div>
      <div id="roadmap" className="printable-roadmap mt-10 grid gap-8 xl:grid-cols-[1fr_300px]">
        <section><div className="mb-4 flex items-center justify-between"><div><h3 className="text-xl font-bold tracking-tight">Daily checklist</h3><p className="mt-1 text-sm text-slate-500">{roadmap.length} planned study days</p></div><CalendarDays className="text-slate-400" size={20} aria-label="Calendar" /></div>{roadmap.length === 0 ? <EmptyRoadmap onNewStrategy={onNewStrategy} /> : <div className="space-y-3">{roadmap.map((day) => <DayAccordion key={day.day} day={day} expanded={expandedDays.includes(day.day)} isToday={day.date === today} onToggle={() => onToggleDay(day.day)} onTopicToggle={onToggleTopic} />)}</div>}</section>
        <aside className="print-hidden space-y-4"><FocusTimer /><div className="overflow-hidden rounded-2xl border border-violet-200 bg-violet-600 p-5 text-white shadow-xl shadow-violet-200/40 dark:border-violet-500/30 dark:shadow-black/20"><div className="mb-7 flex items-start justify-between"><div><p className="text-sm font-semibold text-violet-100">Today&apos;s focus</p><p className="mt-1 text-2xl font-black">{todayDay ? `Day ${todayDay.day}` : activeDay ? `Day ${activeDay.day}` : "Ready"}</p></div><div className="rounded-xl bg-white/15 p-2.5"><Target size={20} /></div></div><p className="text-sm text-violet-100">{todayDay ? formatDate(todayDay.date) : "No schedule for today"}</p><div className="mt-4 flex items-center gap-2 text-sm font-semibold"><Clock3 size={15} /> {formatMinutes(plannedMinutes)} planned</div></div><div className="surface-card p-5"><div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><RefreshCw size={18} /></div><h3 className="font-bold">Fell behind?</h3><p className="mt-1 text-sm leading-6 text-slate-500">Preview unfinished topics across the remaining days without changing your exam date.</p><button onClick={onRebalance} disabled={Boolean(rebalancePreview) || roadmap.length === 0} className="secondary-button mt-4 w-full justify-center text-xs"><RefreshCw size={15} /> Preview a new schedule</button>{canUndoRebalance && <button onClick={onUndoRebalance} className="secondary-button mt-2 w-full justify-center text-xs"><RotateCcw size={15} /> Undo last rebalance</button>}{notice && <p role="status" className="mt-3 text-xs font-semibold text-emerald-600">{notice}</p>}{rebalancePreview && <RebalancePreview preview={rebalancePreview} onApply={onApplyRebalance} onCancel={onCancelRebalance} />}</div></aside>
      </div>
    </div>
  );
}

function RebalancePreview({
  preview,
  onApply,
  onCancel,
}: {
  preview: ReturnType<typeof rebalanceRoadmap>;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={`mt-4 rounded-xl border p-4 text-sm ${preview.isFeasible ? "border-violet-200 bg-violet-50 text-violet-950" : "border-amber-200 bg-amber-50 text-amber-950"}`} role="status">
      <p className="font-bold">{preview.isFeasible ? "Schedule preview" : "This plan cannot fit before the exam"}</p>
      <p className="mt-1 text-xs leading-5">
        {preview.isFeasible
          ? `${preview.movedTaskIds.length} unfinished tasks will use ${preview.availableMinutes} available minutes.`
          : `${preview.overflowTasks.length} unfinished ${preview.overflowTasks.length === 1 ? "task remains" : "tasks remain"} after using ${preview.availableMinutes} available minutes.`}
      </p>
      {!preview.isFeasible && (
        <>
          <p className="mt-2 text-xs font-semibold">
            Nothing was changed. Reduce the workload, add time, or adjust the exam date.
          </p>
          <p className="mt-2 text-xs">
            Still uncovered: {preview.overflowTasks.slice(0, 3).map((task) => task.title).join(", ")}
            {preview.overflowTasks.length > 3 ? ` and ${preview.overflowTasks.length - 3} more` : ""}
          </p>
        </>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onApply} disabled={!preview.isFeasible} className="primary-button h-9 flex-1 px-3 text-xs">
          Apply schedule
        </button>
        <button type="button" onClick={onCancel} className="secondary-button h-9 px-3 text-xs">
          Cancel
        </button>
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
    <section className="mb-6 overflow-hidden rounded-2xl bg-slate-950 p-5 text-white shadow-xl shadow-slate-300/30 sm:p-7 dark:shadow-black/30" aria-label="Study analytics summary">
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
          <div className="h-full rounded-full bg-violet-300 transition-all duration-500" style={{ width: `${stats.percentage}%` }} />
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
