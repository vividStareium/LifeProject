import JSZip from 'jszip';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildDailySummaries, buildHeatmapWeeks } from '@/lib/analytics';
import {
  normalizeHeader,
  parseCsv,
  parseNumberMaybe,
  safeTrim,
  stringifyCsvObjects
} from '@/lib/csv';
import { getBeijingDateInput } from '@/lib/date';
import { isSchemaError } from '@/lib/habit-db';
import {
  buildHabitScoreSeries,
  createRecordSourceKey,
  evaluateHabitRecord,
  normalizeCompletionState
} from '@/lib/habit-domain';
import type {
  FrequencyKind,
  HabitDailyRecordRow,
  HabitImportJobItemRow,
  HabitImportJobRow,
  HabitSourceType,
  HabitTaskLike,
  HabitTemplateRow
} from '@/types/habit';
import type {
  HabitRecordDraft,
  HabitTemplateDraft,
  ImportFileKind,
  ImportPreview,
  ParsedCsvFile,
  TaskDraft
} from '@/types/import';

type CsvRowObject = Record<string, string>;

type ImportCommitSummary = {
  job: HabitImportJobRow | null;
  templateCount: number;
  recordCount: number;
  taskCount: number;
  itemCount: number;
  successRows: number;
  failedRows: number;
  status: 'completed' | 'completed_with_errors' | 'failed';
  warnings: string[];
};

type ExportBundleInput = {
  tasks: HabitTaskLike[];
  templates: HabitTemplateRow[];
  records: HabitDailyRecordRow[];
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const validTaskStatuses = new Set(['todo', 'done', 'cancelled']);
const validPriorities = new Set(['low', 'medium', 'high']);
const validSourceTypes = new Set(['manual', 'csv', 'zip', 'export']);
const validFrequencyKinds = new Set(['daily', 'weekly', 'custom']);

const splitPath = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean);
const basename = (path: string) => splitPath(path).at(-1) ?? path;
const normalizeText = (value: string) => value.trim().toLowerCase();
const isDateCell = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
const unique = <T,>(values: T[]) => Array.from(new Set(values));

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const toObjectRow = (headers: string[], row: string[]) => {
  const result: CsvRowObject = {};

  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (key) {
      result[key] = row[index] ?? '';
    }
  });

  return result;
};

const getRowValue = (row: CsvRowObject, candidates: string[]) => {
  for (const candidate of candidates) {
    const key = Object.keys(row).find((entry) => normalizeText(entry) === normalizeText(candidate));
    if (key) {
      return row[key] ?? '';
    }
  }

  return '';
};

const inferSourceType = (fileName: string): HabitSourceType => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.csv')) return 'csv';
  return 'manual';
};

const normalizeSourceType = (value: string, fallback: HabitSourceType): HabitSourceType => {
  const normalized = value.trim().toLowerCase();
  return validSourceTypes.has(normalized) ? (normalized as HabitSourceType) : fallback;
};

const normalizeFrequencyKind = (value: string): FrequencyKind => {
  const normalized = value.trim().toLowerCase();
  return validFrequencyKinds.has(normalized) ? (normalized as FrequencyKind) : 'daily';
};

const normalizeTargetType = (value: string | null | undefined) =>
  value?.trim().toUpperCase() === 'AT_MOST' ? 'AT_MOST' : 'AT_LEAST';

const normalizeTaskType = (value: string | null | undefined) =>
  value?.trim().toLowerCase() === 'range' ? 'range' : 'single';

const parseFrequencyRule = (value: string) => {
  const text = value.trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { raw: text };
  }
};

const parseCompletionState = (row: CsvRowObject, valueNumber: number | null, valueText: string | null) => {
  const explicit = safeTrim(getRowValue(row, ['completion_state', 'completion state']));
  if (explicit) {
    return normalizeCompletionState(explicit);
  }

  const isDone = safeTrim(getRowValue(row, ['is_done', 'is done']));
  if (isDone) {
    const normalized = isDone.toLowerCase();
    if (['true', '1', 'yes', 'done'].includes(normalized)) return 'done' as const;
    if (['false', '0', 'no', 'missed'].includes(normalized)) return 'missed' as const;
  }

  return valueNumber !== null || valueText ? 'recorded' as const : 'unknown' as const;
};

const detectFileKind = (path: string, headers: string[]): ImportFileKind => {
  const lowerName = basename(path).toLowerCase();
  const normalizedHeaders = headers.map((header) => normalizeHeader(header).toLowerCase());
  const hasHeader = (name: string) => normalizedHeaders.includes(name.toLowerCase());

  if (
    lowerName === 'habit-templates.csv' ||
    lowerName === 'habit_templates.csv' ||
    (
      (hasHeader('source_key') || hasHeader('source key')) &&
      (hasHeader('title') || hasHeader('name')) &&
      !hasHeader('record_date') &&
      !hasHeader('task_date')
    )
  ) {
    return 'habit_templates';
  }

  if (
    lowerName === 'habit-records.csv' ||
    lowerName === 'habit_records.csv' ||
    (
      (hasHeader('template_source_key') || hasHeader('template key') || hasHeader('template_id')) &&
      (hasHeader('record_date') || hasHeader('date'))
    )
  ) {
    return 'habit_records';
  }

  if (lowerName === 'tasks.csv' || ((hasHeader('task_date') || hasHeader('date')) && hasHeader('title'))) {
    return 'tasks';
  }

  return 'unknown';
};

const parseCsvFile = (path: string, text: string): ParsedCsvFile => {
  const { headers, rows } = parseCsv(text);
  const kind = detectFileKind(path, headers);
  const warnings: string[] = [];

  if (kind === 'unknown') {
    warnings.push(`无法识别文件类型：${path}。请使用 tasks.csv、habit-templates.csv 或 habit-records.csv。`);
  }

  return {
    path,
    name: basename(path),
    headers,
    rows,
    kind,
    warnings
  };
};

const parseTaskDrafts = (file: ParsedCsvFile) => {
  const drafts: TaskDraft[] = [];
  const warnings: string[] = [];

  for (const [index, row] of file.rows.entries()) {
    const data = toObjectRow(file.headers, row);
    const title = safeTrim(getRowValue(data, ['title', 'name']));
    const taskDate = safeTrim(getRowValue(data, ['task_date', 'date']));

    if (!title || !taskDate || !isDateCell(taskDate)) {
      warnings.push(`任务文件 ${file.path} 第 ${index + 2} 行缺少标题或日期，已跳过。`);
      continue;
    }

    const status = getRowValue(data, ['status']).toLowerCase();
    const priority = getRowValue(data, ['priority']).toLowerCase();
    const taskType = normalizeTaskType(getRowValue(data, ['task_type', 'task type']));
    const id = safeTrim(getRowValue(data, ['id']));
    const rangeStartDate = safeTrim(getRowValue(data, ['range_start_date', 'range start date']));
    const rangeEndDate = safeTrim(getRowValue(data, ['range_end_date', 'range end date']));

    drafts.push({
      id,
      sourceKey: id ?? `${file.path}:${index + 2}`,
      title,
      description: safeTrim(getRowValue(data, ['description'])),
      taskDate,
      taskType,
      rangeStartDate: rangeStartDate && isDateCell(rangeStartDate) ? rangeStartDate : null,
      rangeEndDate: rangeEndDate && isDateCell(rangeEndDate) ? rangeEndDate : null,
      progressValue: parseNumberMaybe(getRowValue(data, ['progress_value', 'progress value'])),
      targetValue: parseNumberMaybe(getRowValue(data, ['target_value', 'target value'])),
      startTime: safeTrim(getRowValue(data, ['start_time', 'start time'])),
      endTime: safeTrim(getRowValue(data, ['end_time', 'end time'])),
      priority: validPriorities.has(priority) ? (priority as TaskDraft['priority']) : 'medium',
      importance: parseNumberMaybe(getRowValue(data, ['importance', '重要值'])) ?? 50,
      category: safeTrim(getRowValue(data, ['category'])),
      status: validTaskStatuses.has(status) ? (status as TaskDraft['status']) : 'todo'
    });
  }

  return { drafts, warnings };
};

const parseHabitTemplateDrafts = (file: ParsedCsvFile) => {
  const drafts: HabitTemplateDraft[] = [];
  const warnings: string[] = [];
  const fallbackSourceType = inferSourceType(file.path);

  for (const [index, row] of file.rows.entries()) {
    const data = toObjectRow(file.headers, row);
    const sourceKey = safeTrim(getRowValue(data, ['source_key', 'source key'])) ?? `template-${index + 1}`;
    const title = safeTrim(getRowValue(data, ['title', 'name'])) ?? sourceKey;
    const startDate = safeTrim(getRowValue(data, ['start_date', 'start date']));
    const endDate = safeTrim(getRowValue(data, ['end_date', 'end date']));
    const startDateValue = startDate && isDateCell(startDate) ? startDate : null;
    let endDateValue = endDate && isDateCell(endDate) ? endDate : null;

    if (startDateValue && endDateValue && endDateValue < startDateValue) {
      warnings.push(`模板文件 ${file.path} 第 ${index + 2} 行终止日期早于起始日期，已忽略终止日期。`);
      endDateValue = null;
    }

    drafts.push({
      sourceKey,
      sourceName: safeTrim(getRowValue(data, ['source_name', 'source name'])) ?? file.path,
      sourceType: normalizeSourceType(getRowValue(data, ['source_type', 'source type']), fallbackSourceType),
      sortOrder: parseNumberMaybe(getRowValue(data, ['sort_order', 'sort order'])) ?? index,
      title,
      description: safeTrim(getRowValue(data, ['description'])),
      question: safeTrim(getRowValue(data, ['question'])),
      frequencyKind: normalizeFrequencyKind(getRowValue(data, ['frequency_kind', 'frequency kind'])),
      frequencyRule: parseFrequencyRule(getRowValue(data, ['frequency_rule', 'frequency rule'])),
      unit: safeTrim(getRowValue(data, ['unit'])),
      targetType: normalizeTargetType(getRowValue(data, ['target_type', 'target type'])),
      targetValue: parseNumberMaybe(getRowValue(data, ['target_value', 'target value'])),
      color: safeTrim(getRowValue(data, ['color'])),
      startDate: startDateValue,
      endDate: endDateValue,
      archivedAt: safeTrim(getRowValue(data, ['archived_at', 'archived at']))
    });
  }

  if (!drafts.length) {
    warnings.push(`文件 ${file.path} 未解析出任何习惯模板。`);
  }

  return { drafts, warnings };
};

const createTemplateLookup = (drafts: HabitTemplateDraft[]) => {
  const lookup = new Map<string, HabitTemplateDraft>();

  for (const draft of drafts) {
    for (const candidate of unique([draft.sourceKey, draft.sourceKey.toLowerCase(), draft.title, draft.title.toLowerCase()])) {
      lookup.set(candidate, draft);
    }
  }

  return lookup;
};

const parseHabitRecordDrafts = (
  file: ParsedCsvFile,
  templateLookup: Map<string, HabitTemplateDraft>
) => {
  const drafts: HabitRecordDraft[] = [];
  const warnings: string[] = [];
  const fallbackSourceType = inferSourceType(file.path);

  for (const [index, row] of file.rows.entries()) {
    const data = toObjectRow(file.headers, row);
    const recordDate = safeTrim(getRowValue(data, ['record_date', 'date']));

    if (!recordDate || !isDateCell(recordDate)) {
      warnings.push(`记录文件 ${file.path} 第 ${index + 2} 行缺少日期，已跳过。`);
      continue;
    }

    const explicitTemplateKey = safeTrim(getRowValue(data, ['template_source_key', 'template key', 'template_id']));
    const templateTitle = safeTrim(getRowValue(data, ['template_title', 'template name', 'title', 'name']));
    const matchedTemplate = explicitTemplateKey
      ? templateLookup.get(explicitTemplateKey) ?? templateLookup.get(explicitTemplateKey.toLowerCase())
      : templateTitle
        ? templateLookup.get(templateTitle) ?? templateLookup.get(templateTitle.toLowerCase())
        : null;
    const templateSourceKey = matchedTemplate?.sourceKey ?? explicitTemplateKey;

    if (!templateSourceKey) {
      warnings.push(`记录文件 ${file.path} 第 ${index + 2} 行缺少 template_source_key，已跳过。`);
      continue;
    }

    const valueText = safeTrim(getRowValue(data, ['value_text', 'value text']));
    const valueNumber =
      parseNumberMaybe(getRowValue(data, ['value_number', 'value number'])) ??
      parseNumberMaybe(getRowValue(data, ['actual_value', 'actual value']));
    const completionState = parseCompletionState(data, valueNumber, valueText);
    const sourceKey =
      safeTrim(getRowValue(data, ['source_key', 'source key'])) ??
      createRecordSourceKey(templateSourceKey, recordDate);

    drafts.push({
      sourceKey,
      sourceName: file.path,
      sourceType: normalizeSourceType(getRowValue(data, ['source_type', 'source type']), fallbackSourceType),
      templateSourceKey,
      templateTitle: matchedTemplate?.title ?? templateTitle ?? templateSourceKey,
      recordDate,
      valueText,
      valueNumber,
      completionState,
      notes: safeTrim(getRowValue(data, ['notes'])),
      rawPayload: data
    });
  }

  return { drafts, warnings };
};

const normalizeTemplateDrafts = (drafts: HabitTemplateDraft[]) => {
  const seen = new Map<string, HabitTemplateDraft>();

  for (const draft of drafts) {
    const key = draft.sourceKey.trim();
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, draft);
      continue;
    }

    seen.set(key, {
      ...existing,
      ...draft,
      frequencyRule: {
        ...existing.frequencyRule,
        ...draft.frequencyRule
      },
      startDate: draft.startDate ?? existing.startDate,
      endDate: draft.endDate ?? existing.endDate
    });
  }

  return Array.from(seen.values()).sort((left, right) => left.sortOrder - right.sortOrder);
};

const normalizeTaskDrafts = (drafts: TaskDraft[]) =>
  [...drafts].sort((left, right) => left.taskDate.localeCompare(right.taskDate));

const normalizeRecordDrafts = (drafts: HabitRecordDraft[]) =>
  [...drafts].sort((left, right) =>
    left.recordDate.localeCompare(right.recordDate) ||
    left.templateTitle.localeCompare(right.templateTitle, 'zh-CN')
  );

const buildPreviewFromFiles = (
  fileName: string,
  sourceType: 'csv' | 'zip',
  files: ParsedCsvFile[]
): ImportPreview => {
  const warnings = files.flatMap((file) => file.warnings);
  const mappingNotes: string[] = [];
  const taskDrafts: TaskDraft[] = [];
  const templateDrafts: HabitTemplateDraft[] = [];
  const recordDrafts: HabitRecordDraft[] = [];

  for (const file of files.filter((entry) => entry.kind === 'habit_templates')) {
    const result = parseHabitTemplateDrafts(file);
    templateDrafts.push(...result.drafts);
    warnings.push(...result.warnings);
    mappingNotes.push(`${file.name}: 识别为习惯模板 CSV`);
  }

  const normalizedTemplates = normalizeTemplateDrafts(templateDrafts);
  const templateLookup = createTemplateLookup(normalizedTemplates);

  for (const file of files) {
    if (file.kind === 'tasks') {
      const result = parseTaskDrafts(file);
      taskDrafts.push(...result.drafts);
      warnings.push(...result.warnings);
      mappingNotes.push(`${file.name}: 识别为任务 CSV`);
    }

    if (file.kind === 'habit_records') {
      const result = parseHabitRecordDrafts(file, templateLookup);
      recordDrafts.push(...result.drafts);
      warnings.push(...result.warnings);
      mappingNotes.push(`${file.name}: 识别为习惯记录 CSV`);
    }
  }

  const normalizedRecords = normalizeRecordDrafts(recordDrafts);
  const firstRecordDateByTemplateKey = new Map<string, string>();
  for (const record of normalizedRecords) {
    const current = firstRecordDateByTemplateKey.get(record.templateSourceKey);
    if (!current || record.recordDate < current) {
      firstRecordDateByTemplateKey.set(record.templateSourceKey, record.recordDate);
    }
  }

  const templatesWithStartDates = normalizedTemplates.map((template) => {
    const startDate = template.startDate ?? firstRecordDateByTemplateKey.get(template.sourceKey) ?? getBeijingDateInput();
    return {
      ...template,
      startDate,
      endDate: template.endDate && template.endDate < startDate ? null : template.endDate
    };
  });

  return {
    fileName,
    sourceType,
    files,
    templateDrafts: templatesWithStartDates,
    recordDrafts: normalizedRecords,
    taskDrafts: normalizeTaskDrafts(taskDrafts),
    warnings: unique(warnings),
    mappingNotes: unique(mappingNotes)
  };
};

const readZipToFiles = async (file: File) => {
  const archive = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(archive.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith('.csv')
  );

  return Promise.all(
    entries.map(async (entry) => {
      const text = await entry.async('string');
      return parseCsvFile(entry.name, text);
    })
  );
};

export const loadImportPreview = async (file: File): Promise<ImportPreview> => {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.zip') || file.type.includes('zip')) {
    return buildPreviewFromFiles(file.name, 'zip', await readZipToFiles(file));
  }

  if (lowerName.endsWith('.csv')) {
    return buildPreviewFromFiles(file.name, 'csv', [parseCsvFile(file.name, await file.text())]);
  }

  throw new Error('只支持 CSV 或 ZIP 文件。');
};

const toJsonValue = (value: unknown): JsonValue => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry)) as JsonValue;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)])
    ) as JsonValue;
  }

  return value as JsonValue;
};

const createImportJobItems = (
  jobId: string,
  userId: string,
  preview: ImportPreview
) => {
  const items: Omit<HabitImportJobItemRow, 'id' | 'created_at'>[] = [];

  for (const draft of preview.templateDrafts) {
    items.push({
      job_id: jobId,
      user_id: userId,
      source_name: draft.sourceName ?? preview.fileName,
      sheet_name: 'habit_templates',
      source_key: draft.sourceKey,
      raw_payload: toJsonValue(draft) as Record<string, unknown>,
      mapped_payload: {
        entity: 'habit_template',
        source_key: draft.sourceKey,
        title: draft.title,
        start_date: draft.startDate,
        end_date: draft.endDate
      },
      status: 'ok',
      error_message: null
    });
  }

  for (const draft of preview.recordDrafts) {
    items.push({
      job_id: jobId,
      user_id: userId,
      source_name: draft.sourceName ?? preview.fileName,
      sheet_name: 'habit_records',
      source_key: draft.sourceKey,
      raw_payload: toJsonValue(draft) as Record<string, unknown>,
      mapped_payload: {
        entity: 'habit_record',
        template_source_key: draft.templateSourceKey,
        record_date: draft.recordDate,
        value_number: draft.valueNumber,
        completion_state: draft.completionState
      },
      status: 'ok',
      error_message: null
    });
  }

  for (const draft of preview.taskDrafts) {
    items.push({
      job_id: jobId,
      user_id: userId,
      source_name: preview.fileName,
      sheet_name: 'tasks',
      source_key: draft.sourceKey,
      raw_payload: toJsonValue(draft) as Record<string, unknown>,
      mapped_payload: {
        entity: 'task',
        task_date: draft.taskDate,
        title: draft.title
      },
      status: 'ok',
      error_message: null
    });
  }

  return items;
};

const insertRows = async <T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  options: Record<string, unknown> = {}
) => {
  if (!rows.length) {
    return [] as T[];
  }

  const results: T[] = [];

  for (const chunk of chunkArray(rows, 250)) {
    const { data, error } = await supabase.from(table).upsert(chunk as never, options as never).select();

    if (error) {
      throw error;
    }

    if (data) {
      results.push(...(data as T[]));
    }
  }

  return results;
};

const omitKeys = <T extends Record<string, unknown>>(value: T, keys: string[]) => {
  const next = { ...value };
  for (const key of keys) {
    delete next[key];
  }
  return next;
};

const insertTasksWithFallback = async (
  supabase: SupabaseClient,
  rows: Array<Record<string, unknown>>
) => {
  const attempts = [
    rows,
    rows.map((row) => omitKeys(row, ['importance'])),
    rows.map((row) => omitKeys(row, ['task_type', 'range_start_date', 'range_end_date', 'progress_value', 'target_value'])),
    rows.map((row) => omitKeys(row, ['importance', 'task_type', 'range_start_date', 'range_end_date', 'progress_value', 'target_value']))
  ];

  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      return await insertRows(supabase, 'tasks', attempt, { onConflict: 'id' });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
            ? String((error as { message?: unknown }).message)
            : String(error);

      if (!isSchemaError(message) && !message.includes('importance')) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
};

export const commitImportPreview = async (
  supabase: SupabaseClient,
  userId: string,
  preview: ImportPreview
): Promise<ImportCommitSummary> => {
  const totalRows = preview.templateDrafts.length + preview.recordDrafts.length + preview.taskDrafts.length;
  const jobPayload = {
    user_id: userId,
    source_name: preview.fileName,
    source_type: preview.sourceType,
    status: 'processing',
    total_rows: totalRows,
    success_rows: 0,
    failed_rows: 0,
    warning_rows: preview.warnings.length,
    config: {
      warnings: preview.warnings,
      mappingNotes: preview.mappingNotes,
      sourceFileCount: preview.files.length,
      format: 'life-project-csv-v2'
    }
  };

  const { data: job, error: jobError } = await supabase
    .from('import_jobs')
    .insert(jobPayload)
    .select()
    .single();

  if (jobError) {
    throw jobError;
  }

  const jobItems = createImportJobItems(job.id, userId, preview);

  try {
    await insertRows(supabase, 'import_job_items', jobItems as never[]);

    const templateRows = preview.templateDrafts.map((draft) => ({
      user_id: userId,
      source_key: draft.sourceKey,
      source_name: draft.sourceName,
      source_type: draft.sourceType,
      title: draft.title,
      description: draft.description,
      question: draft.question,
      frequency_kind: draft.frequencyKind,
      frequency_rule: toJsonValue(draft.frequencyRule),
      unit: draft.unit,
      target_type: normalizeTargetType(draft.targetType),
      target_value: draft.targetValue,
      color: draft.color,
      sort_order: draft.sortOrder,
      start_date: draft.startDate ?? getBeijingDateInput(),
      end_date: draft.endDate,
      archived_at: draft.archivedAt
    }));

    const savedTemplates = await insertRows(
      supabase,
      'habit_templates',
      templateRows,
      { onConflict: 'user_id,source_key' }
    );

    const templateByKey = new Map(
      savedTemplates.map((template) => [String(template.source_key), template as HabitTemplateRow])
    );
    const recordTemplateKeys = unique(preview.recordDrafts.map((draft) => draft.templateSourceKey));
    const missingTemplateKeys = recordTemplateKeys.filter((key) => !templateByKey.has(key));

    if (missingTemplateKeys.length) {
      const { data, error } = await supabase
        .from('habit_templates')
        .select()
        .eq('user_id', userId)
        .in('source_key', missingTemplateKeys);

      if (error) {
        throw error;
      }

      for (const row of data ?? []) {
        templateByKey.set(String(row.source_key), row as HabitTemplateRow);
      }
    }

    const recordRows = preview.recordDrafts.flatMap((draft) => {
      const template = templateByKey.get(draft.templateSourceKey);
      if (!template) {
        return [];
      }

      return [
        {
          user_id: userId,
          template_id: template.id,
          record_date: draft.recordDate,
          value_text: draft.valueText,
          value_number: draft.valueNumber,
          completion_state: draft.completionState,
          notes: draft.notes,
          source_type: draft.sourceType,
          source_key: draft.sourceKey,
          raw_payload: toJsonValue(draft.rawPayload)
        }
      ];
    });

    const taskRows = preview.taskDrafts.map((draft) => ({
      id: draft.id ?? undefined,
      user_id: userId,
      title: draft.title,
      description: draft.description,
      task_date: draft.taskType === 'range' ? draft.rangeStartDate ?? draft.taskDate : draft.taskDate,
      task_type: draft.taskType,
      range_start_date: draft.taskType === 'range' ? draft.rangeStartDate ?? draft.taskDate : null,
      range_end_date: draft.taskType === 'range' ? draft.rangeEndDate ?? draft.rangeStartDate ?? draft.taskDate : null,
      progress_value: draft.progressValue,
      target_value: draft.targetValue,
      start_time: draft.taskType === 'range' ? null : draft.startTime,
      end_time: draft.taskType === 'range' ? null : draft.endTime,
      status: draft.status,
      priority: draft.priority,
      importance: draft.importance,
      category: draft.category
    }));

    const insertedRecords = await insertRows(supabase, 'habit_daily_records', recordRows, {
      onConflict: 'user_id,template_id,record_date'
    });
    const insertedTasks = await insertTasksWithFallback(supabase, taskRows);

    const successRows =
      preview.templateDrafts.length + insertedRecords.length + insertedTasks.length;
    const failedRows = Math.max(0, totalRows - successRows);
    const status: ImportCommitSummary['status'] =
      failedRows > 0 ? 'completed_with_errors' : 'completed';

    const { error: finishError } = await supabase
      .from('import_jobs')
      .update({
        status,
        success_rows: successRows,
        failed_rows: failedRows,
        finished_at: new Date().toISOString()
      })
      .eq('id', job.id)
      .eq('user_id', userId);

    if (finishError) {
      throw finishError;
    }

    return {
      job,
      templateCount: preview.templateDrafts.length,
      recordCount: insertedRecords.length,
      taskCount: insertedTasks.length,
      itemCount: jobItems.length,
      successRows,
      failedRows,
      status,
      warnings: preview.warnings
    };
  } catch (error) {
    const { error: failUpdateError } = await supabase
      .from('import_jobs')
      .update({
        status: 'failed',
        failed_rows: totalRows,
        finished_at: new Date().toISOString()
      })
      .eq('id', job.id)
      .eq('user_id', userId);

    if (failUpdateError) {
      throw failUpdateError;
    }

    throw error;
  }
};

const exportTaskRows = (tasks: HabitTaskLike[]) =>
  tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    task_date: task.task_date,
    task_type: task.task_type ?? 'single',
    range_start_date: task.range_start_date ?? '',
    range_end_date: task.range_end_date ?? '',
    progress_value: task.progress_value ?? '',
    target_value: task.target_value ?? '',
    start_time: task.start_time ?? '',
    end_time: task.end_time ?? '',
    status: task.status,
    priority: task.priority,
    importance: task.importance ?? 50,
    category: task.category ?? '',
    deleted_at: task.deleted_at ?? ''
  }));

const exportTemplateRows = (templates: HabitTemplateRow[]) =>
  templates.map((template) => ({
    source_key: template.source_key,
    title: template.title,
    description: template.description ?? '',
    question: template.question ?? '',
    frequency_kind: template.frequency_kind,
    frequency_rule: JSON.stringify(template.frequency_rule ?? {}),
    unit: template.unit ?? '',
    target_type: normalizeTargetType(template.target_type),
    target_value: template.target_value ?? '',
    color: template.color ?? '',
    sort_order: template.sort_order,
    start_date: template.start_date,
    end_date: template.end_date ?? '',
    archived_at: template.archived_at ?? '',
    source_name: template.source_name ?? '',
    source_type: template.source_type
  }));

const buildDynamicScoreMap = (records: HabitDailyRecordRow[], templates: HabitTemplateRow[]) => {
  const map = new Map<string, number>();

  for (const template of templates) {
    const templateRecords = records
      .filter((record) => record.template_id === template.id)
      .sort((left, right) => left.record_date.localeCompare(right.record_date));

    if (!templateRecords.length) {
      continue;
    }

    const series = buildHabitScoreSeries(
      template,
      templateRecords,
      template.start_date,
      templateRecords.at(-1)?.record_date ?? template.start_date
    );

    for (const point of series) {
      map.set(`${template.id}:${point.date}`, point.score);
    }
  }

  return map;
};

const exportHabitRecordRows = (records: HabitDailyRecordRow[], templates: HabitTemplateRow[]) => {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const dynamicScoreMap = buildDynamicScoreMap(records, templates);

  return records.map((record) => {
    const template = templateById.get(record.template_id);
    const evaluation = template ? evaluateHabitRecord(template, record, record.record_date) : null;
    const score = dynamicScoreMap.get(`${record.template_id}:${record.record_date}`) ?? 0;

    return {
      template_source_key: template?.source_key ?? '',
      template_title: template?.title ?? '',
      record_date: record.record_date,
      actual_value: evaluation?.actualValue ?? 0,
      normalized_value: evaluation?.normalizedValue ?? 0,
      is_done: evaluation?.isDone ? 'true' : 'false',
      completion_ratio: evaluation?.completionRatio ?? 0,
      score,
      value_text: record.value_text ?? '',
      value_number: record.value_number ?? evaluation?.actualValue ?? '',
      completion_state: record.completion_state,
      notes: record.notes ?? '',
      source_type: record.source_type,
      source_key: record.source_key ?? ''
    };
  });
};

const exportHabitScoreRows = (records: HabitDailyRecordRow[], templates: HabitTemplateRow[]) => {
  const rows: Array<Record<string, unknown>> = [];

  for (const template of templates) {
    const templateRecords = records
      .filter((record) => record.template_id === template.id)
      .sort((left, right) => left.record_date.localeCompare(right.record_date));

    if (!templateRecords.length) {
      continue;
    }

    const series = buildHabitScoreSeries(
      template,
      templateRecords,
      template.start_date,
      templateRecords.at(-1)?.record_date ?? template.start_date
    );

    for (const point of series) {
      rows.push({
        template_source_key: template.source_key,
        template_title: template.title,
        record_date: point.date,
        completion_ratio: point.evaluation.completionRatio,
        score: point.score,
        is_done: point.evaluation.isDone ? 'true' : 'false'
      });
    }
  }

  return rows.sort((left, right) =>
    String(left.template_title).localeCompare(String(right.template_title), 'zh-CN') ||
    String(left.record_date).localeCompare(String(right.record_date))
  );
};

export const buildExportJson = (input: ExportBundleInput) => {
  const summaries = buildDailySummaries(input.tasks, input.records, input.templates);
  const heatmap = buildHeatmapWeeks(summaries, 'activity');
  const habitScores = exportHabitScoreRows(input.records, input.templates);

  return JSON.stringify(
    {
      manifest: {
        version: 2,
        format: 'life-project-csv-v2',
        generatedAt: new Date().toISOString(),
        counts: {
          tasks: input.tasks.length,
          habitTemplates: input.templates.length,
          habitRecords: input.records.length,
          dailySummaries: summaries.length
        }
      },
      tasks: input.tasks,
      habitTemplates: input.templates,
      habitRecords: input.records,
      habitScores,
      dailySummaries: summaries,
      heatmap
    },
    null,
    2
  );
};

export const buildExportZip = async (input: ExportBundleInput) => {
  const zip = new JSZip();
  const summaries = buildDailySummaries(input.tasks, input.records, input.templates);
  const heatmap = buildHeatmapWeeks(summaries, 'activity');

  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        version: 2,
        format: 'life-project-csv-v2',
        generatedAt: new Date().toISOString(),
        counts: {
          tasks: input.tasks.length,
          habitTemplates: input.templates.length,
          habitRecords: input.records.length,
          dailySummaries: summaries.length
        }
      },
      null,
      2
    )
  );

  zip.file('tasks.csv', stringifyCsvObjects([
    'id',
    'title',
    'description',
    'task_date',
    'task_type',
    'range_start_date',
    'range_end_date',
    'progress_value',
    'target_value',
    'start_time',
    'end_time',
    'status',
    'priority',
    'importance',
    'category',
    'deleted_at'
  ], exportTaskRows(input.tasks)));

  zip.file(
    'habit-templates.csv',
    stringifyCsvObjects(
      [
        'source_key',
        'title',
        'description',
        'question',
        'frequency_kind',
        'frequency_rule',
        'unit',
        'target_type',
        'target_value',
        'color',
        'sort_order',
        'start_date',
        'end_date',
        'archived_at',
        'source_name',
        'source_type'
      ],
      exportTemplateRows(input.templates)
    )
  );

  zip.file(
    'habit-records.csv',
    stringifyCsvObjects(
      [
        'template_source_key',
        'template_title',
        'record_date',
        'actual_value',
        'normalized_value',
        'is_done',
        'completion_ratio',
        'score',
        'value_text',
        'value_number',
        'completion_state',
        'notes',
        'source_type',
        'source_key'
      ],
      exportHabitRecordRows(input.records, input.templates)
    )
  );

  zip.file(
    'habit-scores.csv',
    stringifyCsvObjects(
      [
        'template_source_key',
        'template_title',
        'record_date',
        'completion_ratio',
        'score',
        'is_done'
      ],
      exportHabitScoreRows(input.records, input.templates)
    )
  );

  zip.file('heatmap.json', JSON.stringify(heatmap, null, 2));
  zip.file('summary.json', buildExportJson(input));

  return zip.generateAsync({ type: 'blob' });
};

export type {
  ExportBundleInput,
  ImportCommitSummary,
  ParsedCsvFile,
  HabitTemplateDraft,
  HabitRecordDraft,
  TaskDraft
};
