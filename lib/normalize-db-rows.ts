import { parseNumberMaybe } from '@/lib/csv';
import type { HabitDailyRecordRow, HabitTemplateRow } from '@/types/habit';

type UnknownRow = Record<string, unknown>;

export const normalizeHabitTemplateRow = (row: UnknownRow): HabitTemplateRow => ({
  ...(row as HabitTemplateRow),
  target_value:
    row.target_value === null || row.target_value === undefined
      ? null
      : parseNumberMaybe(String(row.target_value))
});

export const normalizeHabitRecordRow = (row: UnknownRow): HabitDailyRecordRow => ({
  ...(row as HabitDailyRecordRow),
  value_number:
    row.value_number === null || row.value_number === undefined
      ? null
      : parseNumberMaybe(String(row.value_number))
});

