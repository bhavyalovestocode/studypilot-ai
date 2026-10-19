export const taskGroups = [
  { key: "theoryTopics", label: "Theory & review" },
  { key: "exercises", label: "Chapter exercises" },
  { key: "practiceQuestions", label: "Active practice" },
] as const;

export type TaskGroupKey = (typeof taskGroups)[number]["key"];

export type StudyTask = {
  id: string;
  title: string;
  subject: string;
  estimatedMinutes: number;
  completed: boolean;
};

export type RoadmapDay = {
  day: number;
  date: string;
  theoryTopics: StudyTask[];
  exercises: StudyTask[];
  practiceQuestions: StudyTask[];
};

export type ProgressSummary = {
  total: number;
  completed: number;
  percentage: number;
};

export type RebalanceResult = {
  proposedRoadmap: RoadmapDay[];
  movedTaskIds: string[];
  overflowTasks: StudyTask[];
  availableMinutes: number;
  unfinishedMinutes: number;
  isFeasible: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTask(value: unknown, fallbackId: string): StudyTask {
  const task = isRecord(value) ? value : {};
  return {
    id: typeof task.id === "string" && task.id ? task.id : fallbackId,
    title: typeof task.title === "string" && task.title.trim() ? task.title : "Study task",
    subject: typeof task.subject === "string" && task.subject.trim() ? task.subject : "General",
    estimatedMinutes:
      typeof task.estimatedMinutes === "number" && Number.isFinite(task.estimatedMinutes)
        ? Math.max(0, task.estimatedMinutes)
        : 0,
    completed: task.completed === true,
  };
}

export function normalizeRoadmap(value: unknown): RoadmapDay[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<RoadmapDay[]>((days, item, dayIndex) => {
    if (!isRecord(item)) return days;
    const getTasks = (key: TaskGroupKey) =>
      (Array.isArray(item[key]) ? item[key] : []).map((task, taskIndex) =>
        normalizeTask(task, `day-${dayIndex + 1}-${key}-${taskIndex + 1}`),
      );

    days.push({
      day: typeof item.day === "number" ? item.day : dayIndex + 1,
      date: typeof item.date === "string" ? item.date : "",
      theoryTopics: getTasks("theoryTopics"),
      exercises: getTasks("exercises"),
      practiceQuestions: getTasks("practiceQuestions"),
    });
    return days;
  }, []);
}

export function isValidStoredRoadmap(value: unknown): value is RoadmapDay[] {
  if (!Array.isArray(value) || value.length === 0) return false;

  const ids = new Set<string>();
  return value.every((day) => {
    if (
      !isRecord(day) ||
      typeof day.day !== "number" ||
      !Number.isInteger(day.day) ||
      typeof day.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
    ) {
      return false;
    }

    return taskGroups.every(({ key }) =>
      Array.isArray(day[key]) &&
      day[key].every((task) => {
        if (
          !isRecord(task) ||
          typeof task.id !== "string" ||
          task.id.length === 0 ||
          ids.has(task.id) ||
          typeof task.title !== "string" ||
          task.title.trim().length === 0 ||
          typeof task.subject !== "string" ||
          typeof task.estimatedMinutes !== "number" ||
          !Number.isFinite(task.estimatedMinutes) ||
          task.estimatedMinutes <= 0 ||
          typeof task.completed !== "boolean"
        ) {
          return false;
        }
        ids.add(task.id);
        return true;
      }),
    );
  });
}

export function getDayTasks(day: RoadmapDay) {
  return taskGroups.flatMap(({ key }) => day[key]);
}

export function calculateProgress(roadmap: RoadmapDay[]): ProgressSummary {
  const tasks = roadmap.flatMap(getDayTasks);
  const completed = tasks.filter((task) => task.completed).length;
  return {
    total: tasks.length,
    completed,
    percentage: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
  };
}

function cloneDayWithCompletedTasks(day: RoadmapDay): RoadmapDay {
  return {
    ...day,
    theoryTopics: day.theoryTopics.filter((task) => task.completed),
    exercises: day.exercises.filter((task) => task.completed),
    practiceQuestions: day.practiceQuestions.filter((task) => task.completed),
  };
}

export function rebalanceRoadmap(
  roadmap: RoadmapDay[],
  dailyHours: number,
  today: string,
): RebalanceResult {
  const capacity = dailyHours * 60;
  const unfinished = roadmap.flatMap((day) =>
    taskGroups.flatMap(({ key }) =>
      day[key]
        .filter((task) => !task.completed)
        .map((task) => ({ key, task })),
    ),
  );
  const proposedRoadmap = roadmap.map(cloneDayWithCompletedTasks);
  const remainingDays = proposedRoadmap.filter((day) => day.date >= today);
  const availableMinutes = remainingDays.reduce((total, day) => {
    const completedMinutes = getDayTasks(day).reduce((sum, task) => sum + task.estimatedMinutes, 0);
    return total + Math.max(0, capacity - completedMinutes);
  }, 0);
  const unfinishedMinutes = unfinished.reduce((total, { task }) => total + task.estimatedMinutes, 0);
  const movedTaskIds: string[] = [];
  const overflowTasks: StudyTask[] = [];

  unfinished.forEach(({ key, task }) => {
    const target = remainingDays.find((day) => {
      const usedMinutes = getDayTasks(day).reduce((sum, item) => sum + item.estimatedMinutes, 0);
      return usedMinutes + task.estimatedMinutes <= capacity;
    });

    if (!target) {
      overflowTasks.push(task);
      return;
    }

    target[key].push(task);
    movedTaskIds.push(task.id);
  });

  return {
    proposedRoadmap,
    movedTaskIds,
    overflowTasks,
    availableMinutes,
    unfinishedMinutes,
    isFeasible: overflowTasks.length === 0,
  };
}
