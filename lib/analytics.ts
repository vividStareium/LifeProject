import type { HabitDailyRecordRow, HabitTaskLike, HabitTemplateRow } from '@/types/habit';
import { addMonths, dateInputDiffInDays, eachDayOfRange, getBeijingDateInput, parseDateInput, startOfDay, toDateInputValue } from '@/lib/date';
import {
  buildHabitScoreSeries,
  calculateNextHabitScore,
  evaluateHabitRecord,
  habitImportance,
  isHabitDueOnDate,
  taskImportance
} from '@/lib/habit-domain';

export type HeatmapMetric =
  | 'activity'
  | 'task_done'
  | 'record_count'
  | 'habit_done'
  | 'score_sum';

export type DailySummary = {
  date: string;
  tasks: HabitTaskLike[];
  records: HabitDailyRecordRow[];
  taskCount: number;
  taskDoneCount: number;
  recordCount: number;
  habitDoneCount: number;
  completionRatioAvg: number;
  weightedCompletionRatio: number;
  scoreSum: number;
  boardScore: number;
  activity: number;
  dueHabits: DailyHabitSummary[];
  taskWeightedCompletionRatio: number;
  habitWeightedCompletionRatio: number;
};

export type DailyHabitSummary = {
  template: HabitTemplateRow;
  record: HabitDailyRecordRow | null;
  actualValue: number;
  completionRatio: number;
  isDone: boolean;
  importance: number;
};

export type HeatmapCell = {
  date: string;
  value: number;
  summary: DailySummary | null;
  outsideRange: boolean;
};

export type HeatmapWeek = {
  index: number;
  days: HeatmapCell[];
};

export type PeriodSize = 'day' | 'week' | 'month' | 'quarter' | 'half_year' | 'year';

export type PeriodPoint = {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  value: number;
  score: number;
};

const groupByDate = <T extends { task_date?: string; record_date?: string }>(
  rows: T[],
  key: 'task_date' | 'record_date'
) => {
  const map = new Map<string, T[]>();

  for (const row of rows) {
    const date = row[key];

    if (!date) {
      continue;
    }

    const list = map.get(date) ?? [];
    list.push(row);
    map.set(date, list);
  }

  return map;
};

const clampRatio = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export const isRangeTask = (task: HabitTaskLike) => task.task_type === 'range';

export const taskRangeStart = (task: HabitTaskLike) => task.range_start_date ?? task.task_date;

export const taskRangeEnd = (task: HabitTaskLike) => task.range_end_date ?? task.range_start_date ?? task.task_date;

export const isTaskDueOnDate = (task: HabitTaskLike, date: string) => {
  if (!isRangeTask(task)) {
    return task.task_date === date;
  }

  return taskRangeStart(task) <= date && date <= taskRangeEnd(task);
};

export const taskCompletionRatio = (task: HabitTaskLike) => {
  if (task.status === 'cancelled') {
    return 0;
  }

  const target = Number(task.target_value ?? 0);
  const progress = Number(task.progress_value ?? 0);

  return target > 0 ? clampRatio(progress / target) : 0;
};

export const taskEffectiveWeight = (task: HabitTaskLike, date: string) => {
  const baseWeight = taskImportance(task);

  if (!isRangeTask(task)) {
    return baseWeight;
  }

  const start = taskRangeStart(task);
  const end = taskRangeEnd(task);
  const totalDays = Math.max(1, dateInputDiffInDays(end, start) + 1);
  const elapsedDays = Math.min(totalDays, Math.max(1, dateInputDiffInDays(date, start) + 1));

  return baseWeight * (elapsedDays / totalDays);
};

export const buildDailySummaries = (
  tasks: HabitTaskLike[],
  records: HabitDailyRecordRow[],
  templates: HabitTemplateRow[] = [],
  referenceDate = getBeijingDateInput(),
  rangeStart?: string
) => {
  const recordMap = groupByDate(records, 'record_date');
  const dates = new Set<string>([...recordMap.keys()]);
  const scoreByDate = new Map<string, number>();
  const parsedStart = parseDateInput(rangeStart ?? '');
  const parsedEnd = parseDateInput(referenceDate);

  for (const task of tasks) {
    if (!isRangeTask(task)) {
      if ((!parsedStart || task.task_date >= toDateInputValue(parsedStart)) && (!parsedEnd || task.task_date <= toDateInputValue(parsedEnd))) {
        dates.add(task.task_date);
      }
      continue;
    }

    const rawStart = parseDateInput(taskRangeStart(task));
    const rawEnd = parseDateInput(taskRangeEnd(task));

    if (!rawStart || !rawEnd || rawStart > rawEnd) {
      dates.add(task.task_date);
      continue;
    }

    const start = parsedStart && parsedStart > rawStart ? parsedStart : rawStart;
    const end = parsedEnd && parsedEnd < rawEnd ? parsedEnd : rawEnd;

    if (start > end) {
      continue;
    }

    for (const date of eachDayOfRange(start, end)) {
      dates.add(toDateInputValue(date));
    }
  }

  if (parsedStart && parsedEnd && parsedStart <= parsedEnd) {
    for (const date of eachDayOfRange(parsedStart, parsedEnd)) {
      dates.add(toDateInputValue(date));
    }
  }

  for (const template of templates) {
    const templateRecords = records
      .filter((record) => record.template_id === template.id)
      .sort((left, right) => left.record_date.localeCompare(right.record_date));

    if (!templateRecords.length) {
      continue;
    }

    const startDate = templateRecords[0].record_date;
    const endDate = referenceDate;
    const series = buildHabitScoreSeries(template, templateRecords, startDate, endDate);

    for (const point of series) {
      dates.add(point.date);
      scoreByDate.set(point.date, (scoreByDate.get(point.date) ?? 0) + point.score);
    }
  }

  const sortedDates = Array.from(dates).sort();

  let previousBoardScore = 0;

  return sortedDates.map<DailySummary>((date) => {
    const taskRows = tasks.filter((task) => isTaskDueOnDate(task, date));
    const recordRows = recordMap.get(date) ?? [];

    const taskDoneCount = taskRows.filter((task) => taskCompletionRatio(task) >= 1).length;
    const recordByTemplate = new Map(recordRows.map((record) => [record.template_id, record]));
    const dueHabits = templates
      .filter((template) => isHabitDueOnDate(template, date))
      .map<DailyHabitSummary>((template) => {
        const record = recordByTemplate.get(template.id) ?? null;
        const evaluation = evaluateHabitRecord(template, record, date);
        return {
          template,
          record,
          actualValue: evaluation.actualValue,
          completionRatio: evaluation.completionRatio,
          isDone: evaluation.isDone,
          importance: habitImportance(template)
        };
      });
    const habitDoneCount = dueHabits.filter((habit) => habit.isDone).length;
    const scoreSum = scoreByDate.get(date) ?? 0;
    const completionRatioAvg = dueHabits.length
      ? dueHabits.reduce((sum, habit) => sum + habit.completionRatio, 0) / dueHabits.length
      : 0;
    const taskWeighted = taskRows.map((task) => ({
      ratio: taskCompletionRatio(task),
      weight: taskEffectiveWeight(task, date)
    }));
    const habitWeighted = dueHabits.map((habit) => ({
      ratio: habit.completionRatio,
      weight: habit.importance
    }));
    const taskWeight = taskWeighted.reduce((sum, item) => sum + item.weight, 0);
    const habitWeight = habitWeighted.reduce((sum, item) => sum + item.weight, 0);
    const taskWeightedCompletionRatio = taskWeight > 0
      ? taskWeighted.reduce((sum, item) => sum + item.ratio * item.weight, 0) / taskWeight
      : 0;
    const habitWeightedCompletionRatio = habitWeight > 0
      ? habitWeighted.reduce((sum, item) => sum + item.ratio * item.weight, 0) / habitWeight
      : 0;
    const weightedItems = [...taskWeighted, ...habitWeighted];
    const totalWeight = weightedItems.reduce((sum, item) => sum + item.weight, 0);
    const weightedCompletionRatio = totalWeight > 0
      ? weightedItems.reduce((sum, item) => sum + item.ratio * item.weight, 0) / totalWeight
      : 0;
    const boardScore = calculateNextHabitScore(previousBoardScore, weightedCompletionRatio);
    previousBoardScore = boardScore;

    return {
      date,
      tasks: taskRows,
      records: recordRows,
      taskCount: taskRows.length,
      taskDoneCount,
      recordCount: recordRows.length,
      habitDoneCount,
      completionRatioAvg,
      weightedCompletionRatio,
      scoreSum,
      boardScore,
      activity: Math.round(weightedCompletionRatio * 1000) / 10,
      dueHabits,
      taskWeightedCompletionRatio,
      habitWeightedCompletionRatio
    };
  });
};

export const metricValue = (summary: DailySummary, metric: HeatmapMetric) => {
  switch (metric) {
    case 'task_done':
      return summary.taskCount > 0 ? (summary.taskDoneCount / summary.taskCount) * 100 : 0;
    case 'record_count':
      return summary.completionRatioAvg * 100;
    case 'habit_done':
      return summary.dueHabits.length > 0 ? (summary.habitDoneCount / summary.dueHabits.length) * 100 : 0;
    case 'score_sum':
      return summary.weightedCompletionRatio * 100;
    case 'activity':
    default:
      return summary.weightedCompletionRatio * 100;
  }
};

export const periodKey = (date: string, period: PeriodSize) => {
  const parsed = parseDateInput(date);
  if (!parsed) {
    return date;
  }

  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;

  if (period === 'day') return date;
  if (period === 'week') {
    const weekStart = new Date(parsed);
    const day = weekStart.getUTCDay();
    weekStart.setUTCDate(weekStart.getUTCDate() - (day === 0 ? 6 : day - 1));
    return toDateInputValue(weekStart);
  }
  if (period === 'month') return `${year}-${String(month).padStart(2, '0')}`;
  if (period === 'quarter') return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === 'half_year') return `${year}-H${month <= 6 ? 1 : 2}`;
  return String(year);
};

export const periodLabel = (period: PeriodSize) => {
  switch (period) {
    case 'day':
      return '天';
    case 'week':
      return '周';
    case 'month':
      return '月';
    case 'quarter':
      return '季度';
    case 'half_year':
      return '半年';
    case 'year':
      return '年';
  }
};

export const buildPeriodPoints = (
  summaries: DailySummary[],
  period: PeriodSize,
  metric: HeatmapMetric = 'activity'
): PeriodPoint[] => {
  const map = new Map<string, DailySummary[]>();

  for (const summary of summaries) {
    const key = periodKey(summary.date, period);
    const list = map.get(key) ?? [];
    list.push(summary);
    map.set(key, list);
  }

  return Array.from(map.entries()).map(([key, list]) => {
    const sorted = [...list].sort((left, right) => left.date.localeCompare(right.date));
    const total = sorted.reduce((sum, summary) => sum + metricValue(summary, metric), 0);
    const value = period === 'day' ? total : total / sorted.length;
    const score = sorted.at(-1)?.boardScore ?? 0;

    return {
      key,
      label: key,
      startDate: sorted[0].date,
      endDate: sorted.at(-1)?.date ?? sorted[0].date,
      value,
      score
    };
  }).sort((left, right) => left.startDate.localeCompare(right.startDate));
};

export const buildHeatmapWeeks = (
  summaries: DailySummary[],
  metric: HeatmapMetric,
  months = 12,
  endDate = parseDateInput(getBeijingDateInput()) ?? new Date(),
  startDate?: Date
) => {
  const end = startOfDay(endDate);
  const start = startDate ? startOfDay(startDate) : addMonths(end, -months);
  if (!startDate) {
    start.setUTCDate(1);
  }
  const gridStart = new Date(start);
  gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());
  const gridEnd = new Date(end);
  const endDay = gridEnd.getUTCDay();
  gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - endDay));

  const summaryMap = new Map(summaries.map((summary) => [summary.date, summary]));
  const days = eachDayOfRange(gridStart, gridEnd);
  const weeks: HeatmapWeek[] = [];

  for (let index = 0; index < days.length; index += 7) {
    weeks.push({
      index: weeks.length,
      days: days.slice(index, index + 7).map((date) => {
        const dateValue = toDateInputValue(date);
        const summary = summaryMap.get(dateValue) ?? null;

        return {
          date: dateValue,
          value: summary ? metricValue(summary, metric) : 0,
          summary,
          outsideRange: date < start || date > end
        };
      })
    });
  }

  const maxValue = Math.max(
    1,
    ...weeks.flatMap((week) => week.days.map((day) => day.value))
  );

  return {
    weeks,
    maxValue,
    rangeStart: toDateInputValue(start),
    rangeEnd: toDateInputValue(end)
  };
};

export const monthLabelsForWeeks = (weeks: HeatmapWeek[]) => {
  const labels: Array<{ weekIndex: number; label: string }> = [];
  let lastMonth = '';

  for (const week of weeks) {
    const firstDay = week.days.find((day) => !day.outsideRange);

    if (!firstDay) {
      continue;
    }

    const monthKey = firstDay.date.slice(0, 7);

    if (monthKey !== lastMonth) {
      lastMonth = monthKey;
      const date = new Date(`${firstDay.date}T00:00:00`);
      labels.push({
        weekIndex: week.index,
        label: date.toLocaleDateString('zh-CN', { month: 'short' })
      });
    }
  }

  return labels;
};
