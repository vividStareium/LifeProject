import type { HabitCompletionState, HabitTemplateRow } from '@/types/habit';
import type { HabitTemplateDraft, HabitRecordDraft } from '@/types/import';
import { normalizeHeader, parseNumberMaybe, safeTrim, slugify } from '@/lib/csv';
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

  if (normalized === 'YES_NO' || normalized === 'BOOLEAN') {
    return 'YES_NO';
  }

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
    case 'YES_NO':
      return '是/否';
    case 'AT_MOST':
      return '不超过';
    case 'AT_LEAST':
      return '至少达到';
    default:
      return '自动判断';
  }
};

export const isYesNoHabit = (
  habit: Pick<HabitTemplateRow, 'target_type' | 'frequency_rule'> | HabitTemplateDraft
) => {
  const targetType = 'target_type' in habit ? habit.target_type : habit.targetType;
  const rule = 'frequency_rule' in habit ? habit.frequency_rule : habit.frequencyRule;
  const legacyType =
    rule && typeof rule === 'object' ? (rule as Record<string, unknown>).type : undefined;

  return (
    normalizeTargetType(targetType) === 'YES_NO' ||
    normalizeTargetType(typeof legacyType === 'string' ? legacyType : null) === 'YES_NO'
  );
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
  template: Pick<HabitTemplateRow, 'frequency_kind' | 'frequency_rule' | 'archived_at'>,
  dateInput: string
) => {
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
  } | null
) => {
  if (!record) {
    return 0;
  }

  if (isYesNoHabit(template)) {
    const stateValue = record.completion_state === 'done' ? 1 : 0;
    const textState = normalizeCompletionState(record.value_text);
    const textValue = textState === 'done' ? 1 : 0;
    const numericValue = record.value_number !== null && record.value_number >= 1 ? 1 : 0;
    return Math.max(stateValue, textValue, numericValue);
  }

  const numericText = parseNumberMaybe(record.value_text ?? '');
  const actual = record.value_number ?? numericText ?? 0;
  return normalizeScaledNumber(actual) ?? 0;
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
    record_date?: string;
  } | null,
  referenceDate = getBeijingDateInput()
): HabitEvaluation => {
  const targetType = isYesNoHabit(template)
    ? 'YES_NO'
    : normalizeTargetType(template.target_type) || 'AT_LEAST';
  const targetValue = template.target_value ?? 1;
  const actualValue = resolveActualValue(template, record);
  const normalizedValue = isYesNoHabit(template) ? actualValue : actualValue;

  let isDone = false;
  let completionRatio = 0;

  if (targetType === 'YES_NO') {
    isDone = actualValue === 1;
    completionRatio = isDone ? 1 : 0;
  } else if (targetType === 'AT_MOST') {
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
  record: {
    value_text: string | null;
    value_number: number | null;
    completion_state: HabitCompletionState;
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

  const recordByDate = new Map(records.map((record) => [record.record_date, record]));
  let previousScore = 0;

  return eachDayOfRange(start, end).map((date) => {
    const dateInput = toDateInputValue(date);
    const record = recordByDate.get(dateInput) ?? null;
    const evaluation = evaluateHabitRecord(template, record, endDate);
    const score = calculateNextHabitScore(previousScore, evaluation.completionRatio);
    previousScore = score;

    return {
      date: dateInput,
      record,
      evaluation: {
        ...evaluation,
        score
      },
      score
    };
  });
};

export const inferFrequencyKind = (row: Record<string, string>) => {
  const numerator = parseNumberMaybe(row.FrequencyNumerator);
  const denominator = parseNumberMaybe(row.FrequencyDenominator);
  const type = normalizeHeader(row.Type ?? '').toUpperCase();

  if (type.includes('WEEK')) {
    return 'weekly' as const;
  }

  if (numerator === 1 && denominator === 1) {
    return 'daily' as const;
  }

  if ((numerator && numerator > 1) || (denominator && denominator > 1)) {
    return 'custom' as const;
  }

  return 'daily' as const;
};

export const buildLegacyFrequencyRule = (row: Record<string, string>) => {
  const numerator = parseNumberMaybe(row.FrequencyNumerator);
  const denominator = parseNumberMaybe(row.FrequencyDenominator);

  return {
    legacy: true,
    numerator,
    denominator,
    type: safeTrim(row.Type)
  };
};

export const buildTemplateSourceKey = (value: string) => value.trim() || `template-${slugify(value)}`;

export const buildHabitTemplateDraft = (
  row: Record<string, string>,
  fallbackOrder: number,
  sourceName: string,
  sourceType: HabitTemplateDraft['sourceType']
): HabitTemplateDraft => {
  const title = safeTrim(row.Name) ?? `Habit ${fallbackOrder + 1}`;
  const position = safeTrim(row.Position) ?? String(fallbackOrder + 1).padStart(3, '0');
  const legacyType = safeTrim(row.Type);
  const targetType = safeTrim(row['Target Type']) ?? (normalizeTargetType(legacyType) === 'YES_NO' ? 'YES_NO' : null);

  return {
    sourceKey: position,
    sourceName,
    sourceType,
    sortOrder: fallbackOrder,
    title,
    description: safeTrim(row.Description),
    question: safeTrim(row.Question),
    frequencyKind: inferFrequencyKind(row),
    frequencyRule: buildLegacyFrequencyRule(row),
    unit: safeTrim(row.Unit),
    targetType,
    targetValue: parseNumberMaybe(row['Target Value']),
    color: safeTrim(row.Color),
    archivedAt: row['Archived?']?.toLowerCase() === 'true' ? new Date().toISOString() : null
  };
};

export const mergeRecordDraft = (
  draft: HabitRecordDraft,
  existing?: HabitRecordDraft | null
): HabitRecordDraft => {
  if (!existing) {
    return draft;
  }

  return {
    ...existing,
    valueText: draft.valueText ?? existing.valueText,
    valueNumber: draft.valueNumber ?? existing.valueNumber,
    completionState:
      draft.completionState === 'unknown' && existing.completionState !== 'unknown'
        ? existing.completionState
        : draft.completionState,
    notes: draft.notes ?? existing.notes,
    rawPayload: {
      ...existing.rawPayload,
      ...draft.rawPayload
    }
  };
};

export const createRecordSourceKey = (templateSourceKey: string, recordDate: string) =>
  `${templateSourceKey}:${recordDate}`;

export const buildTemplateLookupKeys = (value: string) => {
  const cleaned = value.trim();
  const stripped = cleaned.replace(/^\d+\s*[-_.:]?\s*/, '').trim();
  return Array.from(
    new Set(
      [cleaned, cleaned.toLowerCase(), stripped, stripped.toLowerCase()].filter(Boolean)
    )
  );
};

export const resolveTemplateByName = (
  templates: HabitTemplateDraft[],
  value: string
) => {
  const candidates = buildTemplateLookupKeys(value);
  return templates.find((template) =>
    candidates.some(
      (candidate) =>
        template.title === candidate ||
        template.title.toLowerCase() === candidate.toLowerCase() ||
        template.sourceKey === candidate
    )
  );
};
