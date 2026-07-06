import JSZip from 'jszip';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildDailySummaries, buildHeatmapWeeks } from '@/lib/analytics';
import {
  stringifyCsv,
  stringifyCsvObjects,
  parseCsv,
  normalizeHeader,
  parseNumberMaybe,
  safeTrim,
  slugify
} from '@/lib/csv';
import {
  addMonths,
  eachDayOfRange,
  startOfDay,
  toDateInputValue
} from '@/lib/date';
import {
  buildHabitTemplateDraft,
  buildHabitScoreSeries,
  createRecordSourceKey,
  evaluateHabitRecord,
  isYesNoHabit,
  mergeRecordDraft,
  normalizeCompletionState,
  normalizeScaledNumber,
  resolveTemplateByName
} from '@/lib/habit-domain';
import type {
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
const yesValues = new Set(['YES', 'YES_MANUAL', 'TRUE', 'DONE', 'DONE_MANUAL', 'COMPLETED', '1']);
const noValues = new Set(['NO', 'FALSE', 'MISSED', '0']);

const splitPath = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean);

const basename = (path: string) => splitPath(path).at(-1) ?? path;

const parentName = (path: string) => {
  const parts = splitPath(path);
  if (parts.length <= 1) {
    return '';
  }

  return parts[parts.length - 2] ?? '';
};

const normalizeText = (value: string) => value.trim().toLowerCase();

const toObjectRow = (headers: string[], row: string[]) => {
  const result: CsvRowObject = {};

  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (!key) {
      return;
    }

    result[key] = row[index] ?? '';
  });

  return result;
};

const getRowValue = (row: CsvRowObject, candidates: string[]) => {
  for (const candidate of candidates) {
    const key = Object.keys(row).find((entry) => normalizeText(entry) === normalizeText(candidate));
    if (key) {
      const value = row[key];
      if (value !== undefined) {
        return value;
      }
    }
  }

  return '';
};

const isDateCell = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

const unique = <T,>(values: T[]) => Array.from(new Set(values));

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const inferSourceType = (fileName: string): HabitSourceType => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) {
    return 'zip';
  }

  if (lower.endsWith('.csv')) {
    return 'csv';
  }

  return 'manual';
};

const createPlaceholderTemplate = (
  sourceKey: string,
  title: string,
  sourceName: string | null,
  sourceType: HabitSourceType,
  sortOrder: number
): HabitTemplateDraft => ({
  sourceKey,
  sourceName,
  sourceType,
  sortOrder,
  title,
  description: null,
  question: null,
  frequencyKind: 'daily',
  frequencyRule: { inferred: true },
  unit: null,
  targetType: null,
  targetValue: null,
  color: null,
  archivedAt: null
});

const createTemplateLookup = (drafts: HabitTemplateDraft[]) => {
  const lookup = new Map<string, HabitTemplateDraft>();

  for (const draft of drafts) {
    const candidates = unique([
      draft.sourceKey,
      draft.title,
      draft.title.toLowerCase(),
      draft.sourceKey.toLowerCase()
    ].filter(Boolean) as string[]);

    for (const candidate of candidates) {
      lookup.set(candidate, draft);
    }
  }

  return lookup;
};

const resolveTemplateDraft = (
  drafts: HabitTemplateDraft[],
  lookup: Map<string, HabitTemplateDraft>,
  candidate: string,
  sourceName: string,
  sourceType: HabitSourceType,
  sortOrder: number,
  warnings: string[],
  mappingNotes: string[]
) => {
  const resolved = resolveTemplateByName(drafts, candidate);
  if (resolved) {
    return resolved;
  }

  const cleaned = candidate.trim();
  const sourceKey = `auto-${slugify(cleaned)}`;
  const existing = lookup.get(sourceKey);

  if (existing) {
    return existing;
  }

  const placeholder = createPlaceholderTemplate(sourceKey, cleaned, sourceName, sourceType, sortOrder);
  drafts.push(placeholder);
  lookup.set(sourceKey, placeholder);
  lookup.set(cleaned, placeholder);
  lookup.set(cleaned.toLowerCase(), placeholder);
  warnings.push(`未找到与 "${candidate}" 匹配的习惯模板，已自动创建占位模板。`);
  mappingNotes.push(`自动占位: ${candidate} -> ${placeholder.title}`);
  return placeholder;
};

const inferCompletionStateFromValue = (value: string | null | undefined) => {
  const normalized = safeTrim(value)?.toUpperCase();

  if (!normalized) {
    return 'unknown' as const;
  }

  if (yesValues.has(normalized)) {
    return 'done' as const;
  }

  if (noValues.has(normalized)) {
    return 'missed' as const;
  }

  if (normalized === 'UNKNOWN') {
    return 'unknown' as const;
  }

  return 'recorded' as const;
};

const inferTemplateTitleFromPath = (path: string) => {
  const folder = parentName(path);
  if (!folder) {
    return '';
  }

  return folder.replace(/^\d+\s*[-_.:]?\s*/, '').trim();
};

const detectFileKind = (path: string, headers: string[], rows: string[][]): ImportFileKind => {
  const lowerName = basename(path).toLowerCase();
  const normalizedHeaders = headers.map((header) => normalizeHeader(header).toLowerCase());
  const hasHeader = (name: string) => normalizedHeaders.includes(name.toLowerCase());
  const isMatrix = normalizedHeaders[0] === 'date' && headers.length > 2;

  if (lowerName === 'habits.csv' && hasHeader('name') && hasHeader('position')) {
    return 'loop_habits_templates';
  }

  if (lowerName === 'checkmarks.csv' || lowerName === 'scores.csv') {
    if (normalizedHeaders.length <= 3 && (hasHeader('value') || hasHeader('score'))) {
      return 'loop_habits_record_rows';
    }

    if (isMatrix) {
      return lowerName === 'checkmarks.csv'
        ? 'loop_habits_matrix_checkmarks'
        : 'loop_habits_matrix_scores';
    }
  }

  if (
    (hasHeader('source_key') || hasHeader('source key')) &&
    (hasHeader('title') || hasHeader('name')) &&
    !hasHeader('date')
  ) {
    return 'habit_templates';
  }

  if (
    (hasHeader('template_source_key') || hasHeader('template key') || hasHeader('template_id')) &&
    (hasHeader('record_date') || hasHeader('date'))
  ) {
    return 'habit_records';
  }

  if ((hasHeader('task_date') || hasHeader('date')) && hasHeader('title')) {
    return 'tasks';
  }

  if (
    normalizedHeaders[0] === 'date' &&
    normalizedHeaders.some((header) => header === 'value' || header === 'score')
  ) {
    return 'loop_habits_record_rows';
  }

  return 'unknown';
};

const parseCsvFile = (path: string, text: string): ParsedCsvFile => {
  const { headers, rows } = parseCsv(text);
  const kind = detectFileKind(path, headers, rows);
  const warnings: string[] = [];

  if (kind === 'unknown') {
    warnings.push(`无法自动识别文件类型: ${path}`);
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
    const id = safeTrim(getRowValue(data, ['id']));

    drafts.push({
      id,
      sourceKey: id ?? `${file.path}:${index}`,
      title,
      description: safeTrim(getRowValue(data, ['description'])),
      taskDate,
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

  for (const [index, row] of file.rows.entries()) {
    const data = toObjectRow(file.headers, row);

    if (file.kind === 'loop_habits_templates') {
      drafts.push(
        buildHabitTemplateDraft(
          {
            Position: getRowValue(data, ['Position']),
            Name: getRowValue(data, ['Name']),
            Type: getRowValue(data, ['Type']),
            Question: getRowValue(data, ['Question']),
            Description: getRowValue(data, ['Description']),
            FrequencyNumerator: getRowValue(data, ['FrequencyNumerator']),
            FrequencyDenominator: getRowValue(data, ['FrequencyDenominator']),
            Color: getRowValue(data, ['Color']),
            Unit: getRowValue(data, ['Unit']),
            'Target Type': getRowValue(data, ['Target Type']),
            'Target Value': getRowValue(data, ['Target Value']),
            'Archived?': getRowValue(data, ['Archived?'])
          },
          index,
          file.path,
          inferSourceType(file.path)
        )
      );
      continue;
    }

    const sourceKey = safeTrim(getRowValue(data, ['source_key', 'source key'])) ?? `template-${index + 1}`;
    const title = safeTrim(getRowValue(data, ['title', 'name'])) ?? sourceKey;

    drafts.push({
      sourceKey,
      sourceName: file.path,
      sourceType: inferSourceType(file.path),
      sortOrder: index,
      title,
      description: safeTrim(getRowValue(data, ['description'])),
      question: safeTrim(getRowValue(data, ['question'])),
      frequencyKind:
        (safeTrim(getRowValue(data, ['frequency_kind', 'frequency kind']))?.toLowerCase() as
          | HabitTemplateDraft['frequencyKind']
          | undefined) ?? 'daily',
      frequencyRule: (() => {
        const ruleText = safeTrim(getRowValue(data, ['frequency_rule', 'frequency rule']));
        if (!ruleText) {
          return {};
        }

        try {
          return JSON.parse(ruleText) as Record<string, unknown>;
        } catch {
          return { legacy: ruleText };
        }
      })(),
      unit: safeTrim(getRowValue(data, ['unit'])),
      targetType: safeTrim(getRowValue(data, ['target_type', 'target type'])),
      targetValue: parseNumberMaybe(getRowValue(data, ['target_value', 'target value'])),
      color: safeTrim(getRowValue(data, ['color'])),
      archivedAt: safeTrim(getRowValue(data, ['archived_at', 'archived at']))
    });
  }

  if (!drafts.length) {
    warnings.push(`文件 ${file.path} 未解析出任何习惯模板。`);
  }

  return { drafts, warnings };
};

const parseNormalizedHabitRecords = (
  file: ParsedCsvFile,
  templates: HabitTemplateDraft[],
  templateLookup: Map<string, HabitTemplateDraft>,
  recordDrafts: Map<string, HabitRecordDraft>,
  warnings: string[],
  mappingNotes: string[]
) => {
  for (const [index, row] of file.rows.entries()) {
    const data = toObjectRow(file.headers, row);
    const templateSourceKey =
      safeTrim(getRowValue(data, ['template_source_key', 'template key', 'template_id'])) ?? '';
    const templateTitle = safeTrim(
      getRowValue(data, ['template_title', 'template name', 'title', 'name'])
    );
    const recordDate = safeTrim(getRowValue(data, ['record_date', 'date']));

    if (!recordDate || !isDateCell(recordDate)) {
      warnings.push(`记录文件 ${file.path} 第 ${index + 2} 行缺少日期，已跳过。`);
      continue;
    }

    let template =
      templateSourceKey
        ? templateLookup.get(templateSourceKey) ?? resolveTemplateByName(templates, templateSourceKey)
        : null;

    if (!template && templateTitle) {
      template = resolveTemplateByName(templates, templateTitle);
    }

    if (!template) {
      const fallbackCandidate = templateTitle ?? templateSourceKey ?? `record-${index + 1}`;
      template = resolveTemplateDraft(
        templates,
        templateLookup,
        fallbackCandidate,
        file.path,
        inferSourceType(file.path),
        templates.length,
        warnings,
        mappingNotes
      );
    }

    const valueText = safeTrim(
      getRowValue(data, ['value_text', 'value', 'checkmark', 'score', 'raw_value'])
    );
    const valueNumber = normalizeScaledNumber(parseNumberMaybe(
      getRowValue(data, ['value_number', 'score', 'value', 'raw_value'])
    ));
    const completionStateRaw = safeTrim(getRowValue(data, ['completion_state', 'state']));
    const draft: HabitRecordDraft = {
      sourceKey: safeTrim(getRowValue(data, ['source_key'])) ?? createRecordSourceKey(template.sourceKey, recordDate),
      sourceName: file.path,
      sourceType: inferSourceType(file.path),
      templateSourceKey: template.sourceKey,
      templateTitle: template.title,
      recordDate,
      valueText,
      valueNumber,
      completionState: completionStateRaw
        ? (completionStateRaw as HabitRecordDraft['completionState'])
        : valueNumber !== null
          ? 'recorded'
          : inferCompletionStateFromValue(valueText),
      notes: safeTrim(getRowValue(data, ['notes', 'note'])),
      rawPayload: data
    };

    const key = createRecordSourceKey(template.sourceKey, recordDate);
    const existing = recordDrafts.get(key);
    recordDrafts.set(key, mergeRecordDraft(draft, existing));
  }
};

const parseMatrixHabitRecords = (
  file: ParsedCsvFile,
  templates: HabitTemplateDraft[],
  templateLookup: Map<string, HabitTemplateDraft>,
  recordDrafts: Map<string, HabitRecordDraft>,
  warnings: string[],
  mappingNotes: string[]
) => {
  const valueHeader = file.kind === 'loop_habits_matrix_scores' ? 'score' : 'checkmark';

  for (const [rowIndex, row] of file.rows.entries()) {
    const date = safeTrim(row[0]);
    if (!date || !isDateCell(date)) {
      warnings.push(`矩阵文件 ${file.path} 第 ${rowIndex + 2} 行缺少有效日期，已跳过。`);
      continue;
    }

    for (let columnIndex = 1; columnIndex < file.headers.length; columnIndex += 1) {
      const columnName = safeTrim(file.headers[columnIndex]);
      if (!columnName) {
        continue;
      }

      const template = resolveTemplateDraft(
        templates,
        templateLookup,
        columnName,
        file.path,
        inferSourceType(file.path),
        templates.length,
        warnings,
        mappingNotes
      );

      const rawValue = safeTrim(row[columnIndex]);
      if (!rawValue) {
        continue;
      }

      if (valueHeader === 'score') {
        const key = createRecordSourceKey(template.sourceKey, date);
        const existing = recordDrafts.get(key);
        if (existing) {
          recordDrafts.set(key, {
            ...existing,
            rawPayload: {
              ...existing.rawPayload,
              loopScore: parseNumberMaybe(rawValue),
              loopScoreRaw: rawValue
            }
          });
        }
        continue;
      }

      const completionState = inferCompletionStateFromValue(rawValue);
      if (completionState === 'unknown') {
        continue;
      }

      const numericRawValue = parseNumberMaybe(rawValue);
      const valueNumber = isYesNoHabit(template)
        ? completionState === 'done'
          ? 1
          : 0
        : normalizeScaledNumber(numericRawValue);

      const draft: HabitRecordDraft = {
        sourceKey: createRecordSourceKey(template.sourceKey, date),
        sourceName: file.path,
        sourceType: inferSourceType(file.path),
        templateSourceKey: template.sourceKey,
        templateTitle: template.title,
        recordDate: date,
        valueText: isYesNoHabit(template) ? (completionState === 'done' ? '1' : '0') : rawValue,
        valueNumber,
        completionState: isYesNoHabit(template)
          ? completionState === 'done'
            ? 'done'
            : 'missed'
          : numericRawValue !== null
            ? 'recorded'
            : completionState,
        notes: null,
        rawPayload: {
          sourceFile: file.path,
          sourceColumn: columnName,
          rawValue
        }
      };

      const key = createRecordSourceKey(template.sourceKey, date);
      const existing = recordDrafts.get(key);
      recordDrafts.set(key, mergeRecordDraft(draft, existing));
    }
  }
};

const parseRowBasedHabitRecords = (
  file: ParsedCsvFile,
  templates: HabitTemplateDraft[],
  templateLookup: Map<string, HabitTemplateDraft>,
  recordDrafts: Map<string, HabitRecordDraft>,
  warnings: string[],
  mappingNotes: string[]
) => {
  const parent = inferTemplateTitleFromPath(file.path);
  const templateCandidate = parent || basename(file.path);
  const isScoreFile = basename(file.path).toLowerCase() === 'scores.csv';

  for (const [index, row] of file.rows.entries()) {
    const data = toObjectRow(file.headers, row);
    const date = safeTrim(getRowValue(data, ['date', 'record_date']));
    if (!date || !isDateCell(date)) {
      warnings.push(`记录文件 ${file.path} 第 ${index + 2} 行缺少有效日期，已跳过。`);
      continue;
    }

    const template = resolveTemplateDraft(
      templates,
      templateLookup,
      templateCandidate,
      file.path,
      inferSourceType(file.path),
      templates.length,
      warnings,
      mappingNotes
    );

    const valueRaw = safeTrim(getRowValue(data, ['value', 'score', 'checkmark']));
    const notes = safeTrim(getRowValue(data, ['notes', 'note']));
    const numericValue = parseNumberMaybe(valueRaw);
    const key = createRecordSourceKey(template.sourceKey, date);

    if (isScoreFile) {
      const existing = recordDrafts.get(key);
      if (existing) {
        recordDrafts.set(key, {
          ...existing,
          rawPayload: {
            ...existing.rawPayload,
            loopScore: numericValue,
            loopScoreRaw: valueRaw
          }
        });
      }
      continue;
    }

    const completionState = inferCompletionStateFromValue(valueRaw);
    if (completionState === 'unknown') {
      continue;
    }

    const valueNumber = isYesNoHabit(template)
      ? completionState === 'done'
        ? 1
        : 0
      : normalizeScaledNumber(numericValue);

    const draft: HabitRecordDraft = {
      sourceKey: safeTrim(getRowValue(data, ['source_key'])) ?? createRecordSourceKey(template.sourceKey, date),
      sourceName: file.path,
      sourceType: inferSourceType(file.path),
      templateSourceKey: template.sourceKey,
      templateTitle: template.title,
      recordDate: date,
      valueText: isYesNoHabit(template) ? (completionState === 'done' ? '1' : '0') : valueRaw,
      valueNumber,
      completionState:
        isYesNoHabit(template)
          ? completionState === 'done'
            ? 'done'
            : 'missed'
          : numericValue !== null
            ? 'recorded'
            : completionState,
      notes,
      rawPayload: data
    };

    const existing = recordDrafts.get(key);
    recordDrafts.set(key, mergeRecordDraft(draft, existing));
  }
};

const parseGenericFile = (
  file: ParsedCsvFile,
  templates: HabitTemplateDraft[],
  templateLookup: Map<string, HabitTemplateDraft>,
  recordDrafts: Map<string, HabitRecordDraft>,
  taskDrafts: TaskDraft[],
  warnings: string[],
  mappingNotes: string[]
) => {
  if (file.kind === 'tasks') {
    const { drafts, warnings: taskWarnings } = parseTaskDrafts(file);
    taskDrafts.push(...drafts);
    warnings.push(...taskWarnings);
    return;
  }

  if (file.kind === 'habit_templates' || file.kind === 'loop_habits_templates') {
    const { drafts, warnings: templateWarnings } = parseHabitTemplateDrafts(file);
    templates.push(...drafts);
    warnings.push(...templateWarnings);
    return;
  }

  if (file.kind === 'habit_records') {
    parseNormalizedHabitRecords(
      file,
      templates,
      templateLookup,
      recordDrafts,
      warnings,
      mappingNotes
    );
    return;
  }

  if (
    file.kind === 'loop_habits_matrix_checkmarks' ||
    file.kind === 'loop_habits_matrix_scores'
  ) {
    parseMatrixHabitRecords(
      file,
      templates,
      templateLookup,
      recordDrafts,
      warnings,
      mappingNotes
    );
    return;
  }

  if (file.kind === 'loop_habits_record_rows') {
    parseRowBasedHabitRecords(
      file,
      templates,
      templateLookup,
      recordDrafts,
      warnings,
      mappingNotes
    );
  }
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
      }
    });
  }

  return Array.from(seen.values()).sort((left, right) => left.sortOrder - right.sortOrder);
};

const normalizeRecordDrafts = (drafts: Map<string, HabitRecordDraft>) =>
  Array.from(drafts.values()).sort((left, right) => {
    if (left.recordDate === right.recordDate) {
      return left.templateTitle.localeCompare(right.templateTitle, 'zh-CN');
    }

    return left.recordDate.localeCompare(right.recordDate);
  });

const normalizeTaskDrafts = (drafts: TaskDraft[]) =>
  [...drafts].sort((left, right) => left.taskDate.localeCompare(right.taskDate));

const buildPreviewFromFiles = (
  fileName: string,
  sourceType: 'csv' | 'zip',
  files: ParsedCsvFile[]
): ImportPreview => {
  const warnings: string[] = [];
  const mappingNotes: string[] = [];
  const templates: HabitTemplateDraft[] = [];
  const templateLookup = new Map<string, HabitTemplateDraft>();
  const recordDrafts = new Map<string, HabitRecordDraft>();
  const taskDrafts: TaskDraft[] = [];

  const templateFiles = files.filter((file) =>
    file.kind === 'loop_habits_templates' || file.kind === 'habit_templates'
  );

  for (const file of templateFiles) {
    const { drafts, warnings: templateWarnings } = parseHabitTemplateDrafts(file);
    templates.push(...drafts);
    warnings.push(...templateWarnings);
  }

  const normalizedTemplates = normalizeTemplateDrafts(templates);
  normalizedTemplates.forEach((draft) => {
    const candidates = unique([
      draft.sourceKey,
      draft.sourceKey.toLowerCase(),
      draft.title,
      draft.title.toLowerCase()
    ]);
    for (const candidate of candidates) {
      templateLookup.set(candidate, draft);
    }
  });

  for (const file of files) {
    if (templateFiles.includes(file)) {
      continue;
    }

    parseGenericFile(
      file,
      normalizedTemplates,
      templateLookup,
      recordDrafts,
      taskDrafts,
      warnings,
      mappingNotes
    );
  }

  const parsedFiles = files.map<ParsedCsvFile>((file) => ({
    ...file,
    warnings: [...file.warnings]
  }));

  const cleanedTemplates = normalizeTemplateDrafts(normalizedTemplates).filter(
    (template) => !(template.sourceKey.startsWith('auto-') && template.title.toLowerCase().endsWith('.csv'))
  );
  const allowedTemplateKeys = new Set(cleanedTemplates.map((template) => template.sourceKey));
  const cleanedRecords = normalizeRecordDrafts(recordDrafts).filter((record) =>
    allowedTemplateKeys.has(record.templateSourceKey)
  );
  const cleanedWarnings = unique(warnings).filter(
    (warning) =>
      !(
        warning.includes('未找到与 "Scores.csv" 匹配的习惯模板') ||
        warning.includes('未找到与 "Checkmarks.csv" 匹配的习惯模板')
      )
  );

  return {
    fileName,
    sourceType,
    files: parsedFiles,
    templateDrafts: cleanedTemplates,
    recordDrafts: cleanedRecords,
    taskDrafts: normalizeTaskDrafts(taskDrafts),
    warnings: cleanedWarnings,
    mappingNotes: unique(mappingNotes)
  };
};

const readZipToFiles = async (file: File) => {
  const archive = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(archive.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith('.csv')
  );

  const parsed = await Promise.all(
    entries.map(async (entry) => {
      const text = await entry.async('string');
      return parseCsvFile(entry.name, text);
    })
  );

  return parsed;
};

export const loadImportPreview = async (file: File): Promise<ImportPreview> => {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.zip') || file.type.includes('zip')) {
    const files = await readZipToFiles(file);
    const hasNormalizedBundle = files.some((entry) =>
      ['habit_templates', 'habit_records', 'tasks'].includes(entry.kind)
    );
    const legacyKinds = new Set<ImportFileKind>([
      'loop_habits_templates',
      'loop_habits_matrix_checkmarks',
      'loop_habits_matrix_scores',
      'loop_habits_record_rows'
    ]);
    const filteredFiles = hasNormalizedBundle
      ? files.filter((entry) => !legacyKinds.has(entry.kind))
      : files;
    return buildPreviewFromFiles(file.name, 'zip', filteredFiles);
  }

  if (lowerName.endsWith('.csv')) {
    const text = await file.text();
    const parsed = parseCsvFile(file.name, text);
    return buildPreviewFromFiles(file.name, 'csv', [parsed]);
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
        title: draft.title
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
        value_text: draft.valueText,
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
      source_name: draft.sourceKey,
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
      sourceFileCount: preview.files.length
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
      target_type: draft.targetType,
      target_value: draft.targetValue,
      color: draft.color,
      sort_order: draft.sortOrder,
      archived_at: draft.archivedAt
    }));

    const savedTemplates = await insertRows(
      supabase,
      'habit_templates',
      templateRows,
      { onConflict: 'user_id,source_key' }
    );

    const templateByKey = new Map(
      savedTemplates.map((template) => [template.source_key, template as HabitTemplateRow])
    );

    for (const draft of preview.templateDrafts) {
      if (!templateByKey.has(draft.sourceKey)) {
        const { data } = await supabase
          .from('habit_templates')
          .select()
          .eq('user_id', userId)
          .eq('source_key', draft.sourceKey)
          .single();

        if (data) {
          templateByKey.set(draft.sourceKey, data as HabitTemplateRow);
        }
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
      task_date: draft.taskDate,
      start_time: draft.startTime,
      end_time: draft.endTime,
      status: draft.status,
      priority: draft.priority,
      importance: draft.importance,
      category: draft.category
    }));

    const insertedRecords = await insertRows(supabase, 'habit_daily_records', recordRows, {
      onConflict: 'user_id,template_id,record_date'
    });
    let insertedTasks: typeof taskRows = [];
    try {
      insertedTasks = await insertRows(supabase, 'tasks', taskRows, { onConflict: 'id' });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
            ? String((error as { message?: unknown }).message)
            : String(error);

      if (!errorMessage.includes('importance')) {
        throw error;
      }

      const fallbackTaskRows = taskRows.map(({ importance, ...row }) => row);
      insertedTasks = await insertRows(supabase, 'tasks', fallbackTaskRows, { onConflict: 'id' }) as typeof taskRows;
    }

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

const exportTemplateRows = (templates: HabitTemplateRow[]) =>
  templates.map((template) => ({
    source_key: template.source_key,
    title: template.title,
    description: template.description ?? '',
    question: template.question ?? '',
    frequency_kind: template.frequency_kind,
    frequency_rule: JSON.stringify(template.frequency_rule ?? {}),
    unit: template.unit ?? '',
    target_type: template.target_type ?? '',
    target_value: template.target_value ?? '',
    color: template.color ?? '',
    sort_order: template.sort_order,
    archived_at: template.archived_at ?? '',
    source_name: template.source_name ?? '',
    source_type: template.source_type
  }));

const exportTaskRows = (tasks: HabitTaskLike[]) =>
  tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    task_date: task.task_date,
    start_time: task.start_time ?? '',
    end_time: task.end_time ?? '',
    status: task.status,
    priority: task.priority,
    importance: task.importance ?? 50,
    category: task.category ?? '',
    deleted_at: task.deleted_at ?? ''
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
      templateRecords[0].record_date,
      templateRecords.at(-1)?.record_date ?? templateRecords[0].record_date
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
    const evaluation = template ? evaluateHabitRecord(template, record) : null;
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
      value_text: '',
      value_number: evaluation?.actualValue ?? 0,
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
      templateRecords[0].record_date,
      templateRecords.at(-1)?.record_date ?? templateRecords[0].record_date
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

const exportLegacyHabitsRows = (templates: HabitTemplateRow[]) =>
  templates.map((template, index) => {
    const rule = template.frequency_rule ?? {};
    const legacyRule = typeof rule === 'object' && rule !== null ? rule : {};
    const numerator = typeof legacyRule === 'object' ? (legacyRule as Record<string, unknown>).numerator : undefined;
    const denominator =
      typeof legacyRule === 'object' ? (legacyRule as Record<string, unknown>).denominator : undefined;

    return {
      Position: String(index + 1).padStart(3, '0'),
      Name: template.title,
      Type: (legacyRule as Record<string, unknown>).type ?? template.frequency_kind.toUpperCase(),
      Question: template.question ?? '',
      Description: template.description ?? '',
      FrequencyNumerator: numerator ?? 1,
      FrequencyDenominator: denominator ?? 1,
      Color: template.color ?? '',
      Unit: template.unit ?? '',
      'Target Type': template.target_type ?? '',
      'Target Value': template.target_value ?? '',
      'Archived?': template.archived_at ? 'true' : 'false',
      'Source Key': template.source_key,
      'Source Type': template.source_type
    };
  });

const buildLegacyMatrixRows = (
  records: HabitDailyRecordRow[],
  templates: HabitTemplateRow[],
  metric: 'checkmark' | 'score'
) => {
  const templateOrder = [...templates].sort((left, right) => left.sort_order - right.sort_order);
  const templateMap = new Map(templateOrder.map((template) => [template.id, template]));
  const dynamicScoreMap = buildDynamicScoreMap(records, templates);
  const dates = unique(records.map((record) => record.record_date)).sort();
  const recordMap = new Map<string, HabitDailyRecordRow>();

  for (const record of records) {
    recordMap.set(`${record.record_date}:${record.template_id}`, record);
  }

  const rows = dates.map((date) => {
    const row: Record<string, unknown> = { Date: date };

    for (const template of templateOrder) {
      const record = recordMap.get(`${date}:${template.id}`);
      if (!record) {
        row[template.title] = '';
        continue;
      }

      if (metric === 'score') {
        row[template.title] = dynamicScoreMap.get(`${template.id}:${date}`) ?? 0;
      } else {
        row[template.title] = evaluateHabitRecord(template, record).isDone ? 'YES_MANUAL' : 'UNKNOWN';
      }
    }

    return row;
  });

  return {
    headers: ['Date', ...templateOrder.map((template) => template.title)],
    rows
  };
};

const buildLegacyPerHabitRows = (
  templates: HabitTemplateRow[],
  records: HabitDailyRecordRow[]
) => {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const dynamicScoreMap = buildDynamicScoreMap(records, templates);
  const rowsByTemplate = new Map<string, HabitDailyRecordRow[]>();

  for (const record of records) {
    const list = rowsByTemplate.get(record.template_id) ?? [];
    list.push(record);
    rowsByTemplate.set(record.template_id, list);
  }

  return templates.map((template) => ({
    folder: `${String(template.sort_order + 1).padStart(3, '0')} ${template.title}`,
    template,
    checkmarks: (rowsByTemplate.get(template.id) ?? [])
      .slice()
      .sort((left, right) => right.record_date.localeCompare(left.record_date))
      .map((record) => ({
        Date: record.record_date,
        Value: evaluateHabitRecord(template, record).actualValue,
        Notes: record.notes ?? ''
      })),
    scores: (rowsByTemplate.get(template.id) ?? [])
      .slice()
      .sort((left, right) => right.record_date.localeCompare(left.record_date))
      .map((record) => ({
        Date: record.record_date,
        Score: dynamicScoreMap.get(`${template.id}:${record.record_date}`) ?? 0
      }))
  }));
};

export const buildExportJson = (input: ExportBundleInput) => {
  const summaries = buildDailySummaries(input.tasks, input.records, input.templates);
  const heatmap = buildHeatmapWeeks(summaries, 'activity');
  const habitScores = exportHabitScoreRows(input.records, input.templates);

  return JSON.stringify(
    {
      manifest: {
        version: 1,
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
        version: 1,
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

  const legacyFolder = zip.folder('loop-habits-legacy');
  if (legacyFolder) {
    legacyFolder.file('Habits.csv', stringifyCsvObjects([
      'Position',
      'Name',
      'Type',
      'Question',
      'Description',
      'FrequencyNumerator',
      'FrequencyDenominator',
      'Color',
      'Unit',
      'Target Type',
      'Target Value',
      'Archived?',
      'Source Key',
      'Source Type'
    ], exportLegacyHabitsRows(input.templates)));

    const matrixCheckmarks = buildLegacyMatrixRows(input.records, input.templates, 'checkmark');
    const matrixScores = buildLegacyMatrixRows(input.records, input.templates, 'score');
    legacyFolder.file('Checkmarks.csv', stringifyCsv(matrixCheckmarks.headers, matrixCheckmarks.rows.map((row) => matrixCheckmarks.headers.map((header) => row[header] ?? ''))));
    legacyFolder.file('Scores.csv', stringifyCsv(matrixScores.headers, matrixScores.rows.map((row) => matrixScores.headers.map((header) => row[header] ?? ''))));

    for (const habit of buildLegacyPerHabitRows(input.templates, input.records)) {
      const folder = legacyFolder.folder(habit.folder);
      if (!folder) {
        continue;
      }

      folder.file(
        'Checkmarks.csv',
        stringifyCsvObjects(['Date', 'Value', 'Notes'], habit.checkmarks)
      );
      folder.file('Scores.csv', stringifyCsvObjects(['Date', 'Score'], habit.scores));
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return blob;
};

export type {
  ExportBundleInput,
  ImportCommitSummary,
  ParsedCsvFile,
  HabitTemplateDraft,
  HabitRecordDraft,
  TaskDraft
};
