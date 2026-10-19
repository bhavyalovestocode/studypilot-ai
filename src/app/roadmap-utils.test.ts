import { describe, expect, it } from "vitest";
import { rebalanceRoadmap, type RoadmapDay } from "./roadmap-utils";

const task = (id: string, minutes: number, completed = false) => ({
  id,
  title: id,
  subject: "Math",
  estimatedMinutes: minutes,
  completed,
});

function makeRoadmap(): RoadmapDay[] {
  return [
    {
      day: 1,
      date: "2026-10-19",
      theoryTopics: [task("done", 30, true), task("unfinished-1", 60)],
      exercises: [],
      practiceQuestions: [],
    },
    {
      day: 2,
      date: "2026-10-20",
      theoryTopics: [task("unfinished-2", 60)],
      exercises: [],
      practiceQuestions: [],
    },
    {
      day: 3,
      date: "2026-10-21",
      theoryTopics: [task("unfinished-3", 60)],
      exercises: [],
      practiceQuestions: [],
    },
  ];
}

describe("rebalanceRoadmap", () => {
  it("keeps completed work and fits unfinished tasks within daily capacity", () => {
    const result = rebalanceRoadmap(makeRoadmap(), 2, "2026-10-19");

    expect(result.isFeasible).toBe(true);
    expect(result.overflowTasks).toHaveLength(0);
    expect(result.proposedRoadmap[0].theoryTopics).toEqual([
      task("done", 30, true),
      task("unfinished-1", 60),
    ]);
    expect(result.proposedRoadmap.flatMap((day) => day.theoryTopics).map((item) => item.id))
      .toEqual(["done", "unfinished-1", "unfinished-2", "unfinished-3"]);
    expect(result.proposedRoadmap.every((day) =>
      day.theoryTopics.reduce((sum, item) => sum + item.estimatedMinutes, 0) <= 120,
    )).toBe(true);
  });

  it("reports impossible schedules without silently placing overflow", () => {
    const result = rebalanceRoadmap(makeRoadmap(), 1, "2026-10-19");

    expect(result.isFeasible).toBe(false);
    expect(result.overflowTasks.map((item) => item.id)).toEqual(["unfinished-3"]);
    expect(result.availableMinutes).toBe(150);
    expect(result.unfinishedMinutes).toBe(180);
  });

  it("preserves every roadmap date", () => {
    const roadmap = makeRoadmap();
    const result = rebalanceRoadmap(roadmap, 2, "2026-10-20");

    expect(result.proposedRoadmap.map((day) => day.date)).toEqual(roadmap.map((day) => day.date));
    expect(result.proposedRoadmap[0].theoryTopics).toEqual([task("done", 30, true)]);
  });
});
