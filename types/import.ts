import type {
  FrequencyKind,
  HabitCompletionState,
  HabitSourceType
} from '@/types/habit';

export type ParsedCsvFile = {
  path: string;
  name: string;
  headers: string[];
  rows: string[][];
  kind: ImportFileKind;
  warnings: string[];
};

export type ImportFileKind =
  | 'tasks'
  | 'habit_templates'
  | 'habit_records'
  | 'unknown';

export type HabitTemplateDraft = {
  sourceKey: string;
  sourceName: string | null;
  sourceType: HabitSourceType;
  sortOrder: number;
  title: string;
  description: string | null;
  question: string | null;
  frequencyKind: FrequencyKind;
  frequencyRule: Record<string, unknown>;
  unit: string | null;
  targetType: string | null;
  targetValue: number | null;
  color: string | null;
  startDate: string | null;
  endDate: string | null;
  archivedAt: string | null;
};

export type HabitRecordDraft = {
  sourceKey: string;
  sourceName: string | null;
  sourceType: HabitSourceType;
  templateSourceKey: string;
  templateTitle: string;
  recordDate: string;
  valueText: string | null;
  valueNumber: number | null;
  completionState: HabitCompletionState;
  notes: string | null;
  rawPayload: Record<string, unknown>;
};

export type TaskDraft = {
  id?: string | null;
  sourceKey: string;
  title: string;
  description: string | null;
  taskDate: string;
  taskType: 'single' | 'range';
  rangeStartDate: string | null;
  rangeEndDate: string | null;
  progressValue: number | null;
  targetValue: number | null;
  startTime: string | null;
  endTime: string | null;
  priority: 'low' | 'medium' | 'high';
  importance: number | null;
  category: string | null;
  status: 'todo' | 'done' | 'cancelled';
};

export type ImportPreview = {
  fileName: string;
  sourceType: 'csv' | 'zip';
  files: ParsedCsvFile[];
  templateDrafts: HabitTemplateDraft[];
  recordDrafts: HabitRecordDraft[];
  taskDrafts: TaskDraft[];
  warnings: string[];
  mappingNotes: string[];
};
