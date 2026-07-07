import { parseNumberMaybe } from '@/lib/csv';
import { clampDateInput, getBeijingDateInput, isDateString } from '@/lib/date';
import type { HabitDailyRecordRow, HabitTemplateRow } from '@/types/habit';

type UnknownRow = Record<string, unknown>;

export const normalizeHabitTemplateRow = (row: UnknownRow): HabitTemplateRow => ({
  ...(row as HabitTemplateRow),
  start_date: isDateString(String(row.start_date ?? ''))
    ? String(row.start_date)
    : clampDateInput(
      typeof row.created_at === 'string' ? row.created_at.slice(0, 10) : null,
      getBeijingDateInput()
    ),
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
