import type { HabitCompletionState, HabitSourceType, HabitTemplateRow } from '@/types/habit';
import { parseNumberMaybe, safeTrim } from '@/lib/csv';
import {
  eachDayOfRange,
  getBeijingDateInput,
  parseDateInput,
  toDateInputValue
} from '@/lib/date';

const YES_VALUES = new Set(['YES', 'YES_MANUAL', 'TRUE', 'DONE', 'DONE_MANUAL', 'COMPLETED', '1']);
const NO_VALUES = new Set(['NO', 'FALSE', 'MISSED', '0']);

export const normalizeCompletionState = (
  value: string | null | undefined
): HabitCompletionState => {
  const normalized = safeTrim(value)?.toUpperCase();

  if (!normalized) {
    return 'unknown';
  }

  if (YES_VALUES.has(normalized)) {
    return 'done';
  }

  if (NO_VALUES.has(normalized)) {
    return 'missed';
  }

  if (normalized === 'UNKNOWN') {
    return 'unknown';
  }

  return 'recorded';
};

export const completionStateLabel = (state: HabitCompletionState) => {
  switch (state) {
    case 'done':
      return '完成';
    case 'missed':
      return '未完成';
    case 'recorded':
      return '已记录';
    case 'unknown':
    default:
      return '未知';
  }
};

export const normalizeTargetType = (value: string | null | undefined) => {
  const normalized = safeTrim(value)?.toUpperCase().replace(/\s+/g, '_') ?? '';

  if (normalized === 'AT_MOST' || normalized === 'MAX' || normalized === 'LESS_THAN') {
    return 'AT_MOST';
  }

  if (normalized === 'AT_LEAST' || normalized === 'MIN' || normalized === 'NUMERICAL') {
    return 'AT_LEAST';
  }

  return normalized;
};

export const targetTypeLabel = (value: string | null | undefined) => {
  switch (normalizeTargetType(value)) {
    case 'AT_MOST':
      return '不超过';
    case 'AT_LEAST':
      return '至少达到';
    default:
      return '自动判断';
  }
};

export const normalizeScaledNumber = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const absValue = Math.abs(value);
  if (Number.isInteger(value) && absValue >= 1000) {
    return value / 1000;
  }

  return value;
};

export const formatHabitValue = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '0';
  }

  const rounded = Math.round(value * 1000) / 1000;
  return rounded.toLocaleString('zh-CN', {
    maximumFractionDigits: 3
  });
};

export const clampImportance = (value: unknown, fallback = 50) => {
  const numeric = typeof value === 'number' ? value : parseNumberMaybe(String(value ?? ''));
  if (numeric === null || !Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(100, Math.max(1, Math.round(numeric)));
};

export const habitImportance = (template: Pick<HabitTemplateRow, 'frequency_rule'>) => {
  const rule = template.frequency_rule ?? {};
  const raw = typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>).importance : null;
  return clampImportance(raw);
};

export const isHabitDueOnDate = (
  template: Pick<HabitTemplateRow, 'frequency_kind' | 'frequency_rule' | 'archived_at'> &
    Partial<Pick<HabitTemplateRow, 'start_date' | 'end_date' | 'created_at'>>,
  dateInput: string
) => {
  const startDate = template.start_date ?? template.created_at?.slice(0, 10);
  if (startDate && dateInput < startDate) {
    return false;
  }

  if (template.end_date && dateInput > template.end_date) {
    return false;
  }

  if (template.archived_at && dateInput > template.archived_at.slice(0, 10)) {
    return false;
  }

  const parsedDate = parseDateInput(dateInput);
  if (!parsedDate) {
    return true;
  }

  const rule = template.frequency_rule ?? {};
  const kind = typeof rule === 'object' && rule !== null
    ? ((rule as Record<string, unknown>).kind as string | undefined)
    : undefined;
  const daysOfWeek = typeof rule === 'object' && rule !== null && Array.isArray((rule as Record<string, unknown>).daysOfWeek)
    ? ((rule as Record<string, unknown>).daysOfWeek as unknown[]).map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
    : [];
  const daysOfMonth = typeof rule === 'object' && rule !== null && Array.isArray((rule as Record<string, unknown>).daysOfMonth)
    ? ((rule as Record<string, unknown>).daysOfMonth as unknown[]).map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 31)
    : [];

  if (template.frequency_kind === 'weekly') {
    return daysOfWeek.length ? daysOfWeek.includes(parsedDate.getUTCDay()) : true;
  }

  if (kind === 'monthly') {
    return daysOfMonth.length ? daysOfMonth.includes(parsedDate.getUTCDate()) : true;
  }

  return true;
};

export const taskImportance = (task: { importance?: number | null; priority?: string | null }) => {
  if (typeof task.importance === 'number') {
    return clampImportance(task.importance);
  }

  if (task.priority === 'high') return 80;
  if (task.priority === 'low') return 30;
  return 50;
};

export const roundRatio = (value: number) => {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 1000) / 1000;
};

export const resolveActualValue = (
  template: HabitTemplateRow,
  record?: {
    value_text: string | null;
    value_number: number | null;
    completion_state: HabitCompletionState;
    source_type?: HabitSourceType;
  } | null
) => {
  if (!record) {
    return 0;
  }

  const numericText = parseNumberMaybe(record.value_text ?? '');
  const actual = record.value_number ?? numericText ?? 0;
  return record.source_type && record.source_type !== 'manual'
    ? normalizeScaledNumber(actual) ?? 0
    : actual;
};

export type HabitEvaluation = {
  actualValue: number;
  normalizedValue: number;
  isDone: boolean;
  completionRatio: number;
  dailyScore: number;
  score: number;
};

export const calculateNextHabitScore = (previousScore: number, completionRatio: number) => {
  const todayScore = roundRatio(completionRatio) * 100;
  const nextScore = previousScore * 0.95 + todayScore * 0.05;
  return Math.round(Math.min(100, Math.max(0, nextScore)));
};

export const evaluateHabitRecord = (
  template: HabitTemplateRow,
  record?: {
    value_text: string | null;
    value_number: number | null;
    completion_state: HabitCompletionState;
    source_type?: HabitSourceType;
    record_date?: string;
  } | null,
  referenceDate = getBeijingDateInput()
): HabitEvaluation => {
  const targetType = normalizeTargetType(template.target_type) === 'AT_MOST' ? 'AT_MOST' : 'AT_LEAST';
  const targetValue = template.target_value ?? 1;
  const actualValue = resolveActualValue(template, record);
  const normalizedValue = actualValue;

  let isDone = false;
  let completionRatio = 0;

  if (targetType === 'AT_MOST') {
    isDone = actualValue <= targetValue;
    if (targetValue <= 0) {
      completionRatio = isDone ? 1 : 0;
    } else if (actualValue <= targetValue) {
      completionRatio = 1;
    } else if (actualValue >= targetValue * 2) {
      completionRatio = 0;
    } else {
      completionRatio = 1 - (actualValue - targetValue) / targetValue;
    }
  } else {
    isDone = actualValue >= targetValue;
    completionRatio = targetValue <= 0 ? (isDone ? 1 : 0) : actualValue / targetValue;
  }

  const roundedRatio = roundRatio(completionRatio);
  const dailyScore = Math.round(roundedRatio * 100);

  return {
    actualValue,
    normalizedValue,
    isDone,
    completionRatio: roundedRatio,
    dailyScore,
    score: dailyScore
  };
};

export type HabitScorePoint = {
  date: string;
  isDue: boolean;
  record: {
    value_text: string | null;
    value_number: number | null;
    completion_state: HabitCompletionState;
    source_type?: HabitSourceType;
    record_date?: string;
  } | null;
  evaluation: HabitEvaluation;
  score: number;
};

export const buildHabitScoreSeries = (
  template: HabitTemplateRow,
  records: Array<{
    value_text: string | null;
    value_number: number | null;
    completion_state: HabitCompletionState;
    source_type?: HabitSourceType;
    record_date: string;
  }>,
  startDate: string,
  endDate: string
): HabitScorePoint[] => {
  const start = parseDateInput(startDate);
  const end = parseDateInput(endDate);

  if (!start || !end || start > end) {
    return [];
  }

  const templateStart = parseDateInput(template.start_date ?? template.created_at?.slice(0, 10) ?? '');
  const effectiveStart = templateStart && templateStart > start ? templateStart : start;
  const templateEnd = parseDateInput(template.end_date ?? '');
  const effectiveEnd = templateEnd && templateEnd < end ? templateEnd : end;

  if (effectiveStart > effectiveEnd) {
    return [];
  }

  const recordByDate = new Map(records.map((record) => [record.record_date, record]));
  let previousScore = 0;

  return eachDayOfRange(effectiveStart, effectiveEnd).map((date) => {
    const dateInput = toDateInputValue(date);
    const record = recordByDate.get(dateInput) ?? null;
    const isDue = isHabitDueOnDate(template, dateInput);
    const evaluation = evaluateHabitRecord(template, record, dateInput);
    const effectiveCompletionRatio = isDue ? evaluation.completionRatio : 0;
    const score = isDue
      ? calculateNextHabitScore(previousScore, effectiveCompletionRatio)
      : previousScore;
    previousScore = score;

    return {
      date: dateInput,
      isDue,
      record,
      evaluation: {
        ...evaluation,
        isDone: isDue && evaluation.isDone,
        completionRatio: effectiveCompletionRatio,
        dailyScore: Math.round(effectiveCompletionRatio * 100),
        score
      },
      score
    };
  });
};

export const createRecordSourceKey = (templateSourceKey: string, recordDate: string) =>
  `${templateSourceKey}:${recordDate}`;
