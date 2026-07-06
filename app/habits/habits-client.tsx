'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import { supabase } from '@/lib/supabase/client';
import { addMonths, clampDateInput, getBeijingDateInput, parseDateInput, shiftDateInput, toDateInputValue } from '@/lib/date';
import { buildHabitScoreSeries, evaluateHabitRecord, formatHabitValue, habitImportance, isHabitDueOnDate, isYesNoHabit } from '@/lib/habit-domain';
import { completionHeatmapStyle } from '@/lib/heatmap-color';
import { normalizeHabitRecordRow, normalizeHabitTemplateRow } from '@/lib/normalize-db-rows';
import type { HabitDailyRecordRow, HabitGroupRow, HabitTemplateRow } from '@/types/habit';

type HabitFormState = {
  title: string;
  description: string;
  question: string;
  frequencyKind: 'daily' | 'weekly' | 'monthly';
  every: string;
  unit: 'day' | 'week' | 'month';
  daysOfWeek: string;
  daysOfMonth: string;
  importance: string;
  targetType: string;
  targetValue: string;
  unitLabel: string;
  color: string;
  groupId: string;
};

type RecordDraftState = {
  valueText: string;
  valueNumber: string;
  notes: string;
};

type GroupFormState = {
  name: string;
  description: string;
  parentId: string;
};

const weekLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const frequencyLabels = {
  daily: '每日',
  weekly: '每周',
  custom: '自定义'
} as const;
const monthDays = Array.from({ length: 31 }, (_, index) => index + 1);

const createHabitForm = (): HabitFormState => ({
  title: '',
  description: '',
  question: '',
  frequencyKind: 'daily',
  every: '1',
  unit: 'day',
  daysOfWeek: '1,3,5',
  daysOfMonth: '1',
  importance: '50',
  targetType: 'AT_LEAST',
  targetValue: '',
  unitLabel: '',
  color: '#2563eb',
  groupId: ''
});

const createGroupForm = (): GroupFormState => ({
  name: '',
  description: '',
  parentId: ''
});

const createRecordDraft = (): RecordDraftState => ({
  valueText: '',
  valueNumber: '',
  notes: ''
});

const describeFrequency = (template: HabitTemplateRow) => {
  const rule = template.frequency_rule ?? {};
  const every = typeof rule === 'object' && rule !== null ? Number((rule as Record<string, unknown>).every ?? 1) : 1;
  const unit = typeof rule === 'object' && rule !== null ? ((rule as Record<string, unknown>).unit as string | undefined) : undefined;
  const days = typeof rule === 'object' && rule !== null ? ((rule as Record<string, unknown>).daysOfWeek as number[] | undefined) : undefined;
  const monthDaysValue = typeof rule === 'object' && rule !== null ? ((rule as Record<string, unknown>).daysOfMonth as number[] | undefined) : undefined;
  const kind = typeof rule === 'object' && rule !== null ? ((rule as Record<string, unknown>).kind as string | undefined) : undefined;

  if (template.frequency_kind === 'daily') {
    return every > 1 ? `每 ${every} 天` : '每日';
  }

  if (template.frequency_kind === 'weekly') {
    if (days?.length) {
      return `每周 ${days.map((day) => weekLabels[day] ?? day).join(' / ')}`;
    }

    return '每周';
  }

  if (kind === 'monthly') {
    if (monthDaysValue?.length) {
      return `每月 ${monthDaysValue.join(' / ')} 号`;
    }

    return '每月';
  }

  return `${every > 1 ? `每 ${every}` : '自定义'} ${unit ?? 'day'}`;
};

const frequencyBadgeLabel = (template: HabitTemplateRow) => {
  const rule = template.frequency_rule ?? {};
  const kind = typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>).kind : null;
  if (kind === 'monthly') return '每月';
  return frequencyLabels[template.frequency_kind];
};

const buildFrequencyRule = (form: HabitFormState) => {
  const every = Math.max(1, Number(form.every) || 1);
  const unit = form.unit;
  const daysOfWeek =
    form.daysOfWeek
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6) ?? [];
  const daysOfMonth =
    form.daysOfMonth
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 31) ?? [];

  return {
    every,
    unit: form.frequencyKind === 'monthly' ? 'month' : unit,
    daysOfWeek: form.frequencyKind === 'weekly' ? daysOfWeek : [],
    daysOfMonth: form.frequencyKind === 'monthly' ? daysOfMonth : [],
    kind: form.frequencyKind,
    importance: Math.min(100, Math.max(1, Number(form.importance) || 50))
  };
};

const isSchemaError = (message: string) => {
  const lower = message.toLowerCase();
  return (
    lower.includes('schema cache') ||
    lower.includes('does not exist') ||
    lower.includes('column') ||
    lower.includes('relation')
  );
};

const completionSurfaceClass = (isComplete: boolean) =>
  isComplete
    ? 'border-emerald-200 bg-gradient-to-r from-emerald-100 via-white to-white'
    : 'border-slate-100 bg-slate-50';

const omitKeys = <T extends Record<string, unknown>>(value: T, keys: string[]) => {
  const next = { ...value };
  for (const key of keys) {
    delete next[key];
  }
  return next;
};

const buildInitialDrafts = (
  templates: HabitTemplateRow[],
  records: HabitDailyRecordRow[],
  selectedDate: string
) => {
  const map: Record<string, RecordDraftState> = {};
  const recordsForDay = new Map(
    records
      .filter((record) => record.record_date === selectedDate)
      .map((record) => [record.template_id, record])
  );

  for (const template of templates) {
    const record = recordsForDay.get(template.id);
    const evaluation = evaluateHabitRecord(template, record, selectedDate);
    map[template.id] = {
      valueText: record?.value_number !== null && record?.value_number !== undefined ? '' : record?.value_text ?? '',
      valueNumber: String(evaluation.actualValue),
      notes: record?.notes ?? ''
    };
  }

  return map;
};

export default function HabitsClient() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savingRecordId, setSavingRecordId] = useState<string>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => getBeijingDateInput());
  const [templates, setTemplates] = useState<HabitTemplateRow[]>([]);
  const [groups, setGroups] = useState<HabitGroupRow[]>([]);
  const [groupsAvailable, setGroupsAvailable] = useState(true);
  const [records, setRecords] = useState<HabitDailyRecordRow[]>([]);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [habitModalOpen, setHabitModalOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [recordModalTemplateId, setRecordModalTemplateId] = useState<string | null>(null);
  const [templateForm, setTemplateForm] = useState<HabitFormState>(createHabitForm());
  const [groupForm, setGroupForm] = useState<GroupFormState>(createGroupForm());
  const [recordDrafts, setRecordDrafts] = useState<Record<string, RecordDraftState>>({});

  const loadData = async () => {
    setLoading(true);
    setError('');

    const {
      data: { user: currentUser }
    } = await supabase.auth.getUser();

    if (!currentUser) {
      router.replace('/auth/login');
      return;
    }

    setUser(currentUser);

    const recordStart = toDateInputValue(
      addMonths(parseDateInput(getBeijingDateInput()) ?? new Date(), -6)
    );
    const [groupResult, templateResultWithGroup, recordResult] = await Promise.all([
      supabase
        .from('habit_groups')
        .select('id,user_id,parent_id,name,description,color,created_at,updated_at')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('habit_templates')
        .select(
          'id,user_id,group_id,source_key,source_name,source_type,title,description,question,frequency_kind,frequency_rule,unit,target_type,target_value,color,sort_order,archived_at,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('habit_daily_records')
        .select(
          'id,user_id,template_id,record_date,value_text,value_number,completion_state,notes,source_type,source_key,raw_payload,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .gte('record_date', recordStart)
        .order('record_date', { ascending: false })
        .order('created_at', { ascending: false })
    ]);

    if (groupResult.error) {
      setGroups([]);
      setGroupsAvailable(false);
    } else {
      setGroups((groupResult.data ?? []) as unknown as HabitGroupRow[]);
      setGroupsAvailable(true);
    }

    const templateResult = templateResultWithGroup.error && isSchemaError(templateResultWithGroup.error.message)
      ? await supabase
        .from('habit_templates')
        .select(
          'id,user_id,source_key,source_name,source_type,title,description,question,frequency_kind,frequency_rule,unit,target_type,target_value,color,sort_order,archived_at,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
      : templateResultWithGroup;

    if (templateResult.error) {
      setError(templateResult.error.message);
      setLoading(false);
      return;
    }

    if (recordResult.error) {
      setError(recordResult.error.message);
      setLoading(false);
      return;
    }

    const loadedTemplates = (templateResult.data ?? []).map((row) =>
      normalizeHabitTemplateRow(row as Record<string, unknown>)
    );
    const loadedRecords = (recordResult.data ?? []).map((row) =>
      normalizeHabitRecordRow(row as Record<string, unknown>)
    );
    setTemplates(loadedTemplates);
    setRecords(loadedRecords);
    setRecordDrafts(buildInitialDrafts(loadedTemplates, loadedRecords, selectedDate));
    setEditingTemplateId(null);
    setTemplateForm(createHabitForm());
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!templates.length) {
      return;
    }

    setRecordDrafts(buildInitialDrafts(templates, records, selectedDate));
  }, [records, selectedDate, templates]);

  const activeTemplates = useMemo(
    () => templates.filter((template) => !template.archived_at),
    [templates]
  );
  const archivedTemplates = useMemo(
    () => templates.filter((template) => Boolean(template.archived_at)),
    [templates]
  );
  const selectedDateRecords = useMemo(
    () => records.filter((record) => record.record_date === selectedDate),
    [records, selectedDate]
  );

  const stats = useMemo(() => {
    const dueTemplates = activeTemplates.filter((template) => isHabitDueOnDate(template, selectedDate));
    const completedToday = dueTemplates.filter((template) => {
      const record = selectedDateRecords.find((item) => item.template_id === template.id);
      return evaluateHabitRecord(template, record, selectedDate).isDone;
    }).length;
    const weightedItems = dueTemplates.map((template) => {
      const record = selectedDateRecords.find((item) => item.template_id === template.id);
      return {
        ratio: evaluateHabitRecord(template, record, selectedDate).completionRatio,
        weight: habitImportance(template)
      };
    });
    const totalWeight = weightedItems.reduce((sum, item) => sum + item.weight, 0);
    const weightedCompletion = totalWeight > 0
      ? weightedItems.reduce((sum, item) => sum + item.ratio * item.weight, 0) / totalWeight
      : 0;

    return {
      totalTemplates: templates.length,
      activeTemplates: activeTemplates.length,
      archivedTemplates: archivedTemplates.length,
      recordsTotal: records.length,
      recordsToday: dueTemplates.length,
      completedToday,
      weightedCompletion
    };
  }, [activeTemplates, archivedTemplates.length, records.length, selectedDate, selectedDateRecords, templates.length]);

  const orderedGroups = useMemo(() => {
    const children = new Map<string, HabitGroupRow[]>();
    const existingIds = new Set(groups.map((group) => group.id));
    for (const group of groups) {
      const parentId = group.parent_id && existingIds.has(group.parent_id) ? group.parent_id : 'root';
      const list = children.get(parentId) ?? [];
      list.push(group);
      children.set(parentId, list);
    }

    const result: Array<{ group: HabitGroupRow; level: number }> = [];
    const visit = (parentId: string, level: number) => {
      for (const group of (children.get(parentId) ?? []).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
        result.push({ group, level });
        visit(group.id, level + 1);
      }
    };

    visit('root', 0);
    return result;
  }, [groups]);

  const groupNameById = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups]
  );

  const groupChildren = useMemo(() => {
    const children = new Map<string, HabitGroupRow[]>();
    for (const group of groups) {
      const parentId = group.parent_id ?? 'root';
      const list = children.get(parentId) ?? [];
      list.push(group);
      children.set(parentId, list);
    }
    return children;
  }, [groups]);

  const groupIdsById = useMemo(() => {
    const collect = (groupId: string, seen = new Set<string>()) => {
      if (seen.has(groupId)) return seen;
      seen.add(groupId);
      for (const child of groupChildren.get(groupId) ?? []) {
        collect(child.id, seen);
      }
      return seen;
    };

    return new Map(groups.map((group) => [group.id, collect(group.id)]));
  }, [groupChildren, groups]);

  const habitGroupStats = useMemo(() => new Map(
    groups.map((group) => {
      const ids = groupIdsById.get(group.id) ?? new Set([group.id]);
      const groupTemplates = activeTemplates.filter((template) => template.group_id && ids.has(template.group_id));
      const dueTemplates = groupTemplates.filter((template) => isHabitDueOnDate(template, selectedDate));
      const weightedItems = dueTemplates.map((template) => {
        const record = selectedDateRecords.find((item) => item.template_id === template.id);
        return {
          ratio: evaluateHabitRecord(template, record, selectedDate).completionRatio,
          weight: habitImportance(template)
        };
      });
      const totalWeight = weightedItems.reduce((sum, item) => sum + item.weight, 0);
      const completion = totalWeight > 0
        ? weightedItems.reduce((sum, item) => sum + item.ratio * item.weight, 0) / totalWeight
        : 0;

      return [group.id, {
        total: dueTemplates.length,
        done: dueTemplates.filter((template) => {
          const record = selectedDateRecords.find((item) => item.template_id === template.id);
          return evaluateHabitRecord(template, record, selectedDate).isDone;
        }).length,
        allTemplates: groupTemplates.length,
        completion,
        score: Math.round(completion * 100)
      }];
    })
  ), [activeTemplates, groupIdsById, groups, selectedDate, selectedDateRecords]);

  const selectedGroup = selectedGroupId
    ? groups.find((group) => group.id === selectedGroupId) ?? null
    : null;
  const selectedGroupIds = selectedGroupId ? groupIdsById.get(selectedGroupId) ?? new Set([selectedGroupId]) : new Set<string>();
  const selectedGroupTemplates = selectedGroup
    ? activeTemplates.filter((template) => template.group_id && selectedGroupIds.has(template.group_id))
    : [];
  const selectedGroupStats = selectedGroupId
    ? habitGroupStats.get(selectedGroupId) ?? { total: 0, done: 0, allTemplates: 0, completion: 0, score: 0 }
    : { total: 0, done: 0, allTemplates: 0, completion: 0, score: 0 };
  const selectedGroupTimeline = useMemo(() => {
    if (!selectedGroup || selectedGroupTemplates.length === 0) {
      return [];
    }

    const startInput = shiftDateInput(selectedDate, -89);
    const dates = Array.from({ length: 90 }, (_, index) => shiftDateInput(selectedDate, -index));
    const recordByTemplateAndDate = new Map(
      records.map((record) => [`${record.template_id}:${record.record_date}`, record])
    );
    const scoreByTemplateAndDate = new Map<string, number>();

    for (const template of selectedGroupTemplates) {
      const templateRecords = records.filter((record) => record.template_id === template.id);
      for (const point of buildHabitScoreSeries(template, templateRecords, startInput, selectedDate)) {
        scoreByTemplateAndDate.set(`${template.id}:${point.date}`, point.score);
      }
    }

    return dates.map((date) => {
      const dueTemplates = selectedGroupTemplates.filter((template) => isHabitDueOnDate(template, date));
      const completionItems = dueTemplates.map((template) => {
        const record = recordByTemplateAndDate.get(`${template.id}:${date}`);
        return {
          ratio: evaluateHabitRecord(template, record, date).completionRatio,
          weight: habitImportance(template)
        };
      });
      const completionWeight = completionItems.reduce((sum, item) => sum + item.weight, 0);
      const completion = completionWeight > 0
        ? completionItems.reduce((sum, item) => sum + item.ratio * item.weight, 0) / completionWeight
        : 0;
      const scoreItems = selectedGroupTemplates.map((template) => ({
        score: scoreByTemplateAndDate.get(`${template.id}:${date}`) ?? 0,
        weight: habitImportance(template)
      }));
      const scoreWeight = scoreItems.reduce((sum, item) => sum + item.weight, 0);
      const score = scoreWeight > 0
        ? scoreItems.reduce((sum, item) => sum + item.score * item.weight, 0) / scoreWeight
        : 0;

      return {
        date,
        completion,
        score: Math.round(score)
      };
    });
  }, [records, selectedDate, selectedGroup, selectedGroupTemplates]);
  const selectedGroupScorePoints = useMemo(() => {
    const points = [...selectedGroupTimeline].reverse();
    if (points.length === 0) {
      return '';
    }

    return points
      .map((point, index) => {
        const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
        const y = 34 - (Math.min(100, Math.max(0, point.score)) / 100) * 30;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [selectedGroupTimeline]);

  const resetTemplateForm = () => {
    setEditingTemplateId(null);
    setTemplateForm(createHabitForm());
    setHabitModalOpen(false);
  };

  const renderGroupOptions = (placeholder = '不加入组') => (
    <>
      <option value=''>{placeholder}</option>
      {orderedGroups.map(({ group, level }) => (
        <option key={group.id} value={group.id}>
          {'　'.repeat(level)}{group.name}
        </option>
      ))}
    </>
  );

  const createGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) {
      setError('请先登录');
      return;
    }

    if (!groupForm.name.trim()) {
      setError('组名不能为空');
      return;
    }

    setSavingTemplate(true);
    setError('');

    const { error: groupError } = await supabase
      .from('habit_groups')
      .insert([{
        user_id: user.id,
        name: groupForm.name.trim(),
        description: groupForm.description.trim() || null,
        parent_id: groupForm.parentId || null
      }]);

    if (groupError) {
      if (isSchemaError(groupError.message)) {
        setGroupsAvailable(false);
        setError('数据库还没有启用习惯组，请先执行 docs/sql/02_habits_import_export_schema.sql。');
      } else {
        setError(groupError.message);
      }
      setSavingTemplate(false);
      return;
    }

    setGroupModalOpen(false);
    setGroupForm(createGroupForm());
    await loadData();
    setSavingTemplate(false);
    setMessage('已创建习惯组');
    window.setTimeout(() => setMessage(''), 1500);
  };

  const deleteSelectedGroup = async () => {
    if (!user || !selectedGroup) {
      return;
    }

    if (!window.confirm(`确定删除习惯组“${selectedGroup.name}”吗？组内习惯不会被删除，只会移出该组。`)) {
      return;
    }

    setSavingTemplate(true);
    setError('');

    const { error: templateUpdateError } = await supabase
      .from('habit_templates')
      .update({ group_id: null })
      .eq('user_id', user.id)
      .eq('group_id', selectedGroup.id);

    if (templateUpdateError) {
      setError(templateUpdateError.message);
      setSavingTemplate(false);
      return;
    }

    const { error: childUpdateError } = await supabase
      .from('habit_groups')
      .update({ parent_id: null })
      .eq('user_id', user.id)
      .eq('parent_id', selectedGroup.id);

    if (childUpdateError) {
      setError(childUpdateError.message);
      setSavingTemplate(false);
      return;
    }

    const { error: groupDeleteError } = await supabase
      .from('habit_groups')
      .delete()
      .eq('id', selectedGroup.id)
      .eq('user_id', user.id);

    if (groupDeleteError) {
      setError(groupDeleteError.message);
      setSavingTemplate(false);
      return;
    }

    setSelectedGroupId(null);
    await loadData();
    setSavingTemplate(false);
    setMessage('已删除习惯组，组内习惯已移出该组');
    window.setTimeout(() => setMessage(''), 1500);
  };

  const handleSubmitTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) {
      setError('请先登录');
      return;
    }

    if (!templateForm.title.trim()) {
      setError('习惯标题不能为空');
      return;
    }

    setSavingTemplate(true);
    setError('');

    const currentTemplate = editingTemplateId
      ? templates.find((template) => template.id === editingTemplateId) ?? null
      : null;
    const sourceKey = currentTemplate?.source_key ?? `habit-${crypto.randomUUID()}`;

    const payload = {
      user_id: user.id,
      source_key: sourceKey,
      source_name: 'manual',
      source_type: 'manual',
      title: templateForm.title.trim(),
      description: templateForm.description.trim() || null,
      question: null,
      frequency_kind: templateForm.frequencyKind === 'monthly' ? 'custom' : templateForm.frequencyKind,
      frequency_rule: buildFrequencyRule(templateForm),
      unit: templateForm.unitLabel.trim() || null,
      target_type: templateForm.targetType === 'AT_MOST' ? 'AT_MOST' : 'AT_LEAST',
      target_value: templateForm.targetValue ? Number(templateForm.targetValue) : null,
      color: null,
      group_id: templateForm.groupId || null,
      sort_order: currentTemplate?.sort_order ?? templates.length,
      archived_at: currentTemplate?.archived_at ?? null
    };

    let templateSaveResult = await supabase
      .from('habit_templates')
      .upsert(payload, { onConflict: 'user_id,source_key' })
      .select()
      .single();

    if (templateSaveResult.error && isSchemaError(templateSaveResult.error.message)) {
      setGroupsAvailable(false);
      templateSaveResult = await supabase
        .from('habit_templates')
        .upsert(omitKeys(payload, ['group_id']), { onConflict: 'user_id,source_key' })
        .select()
        .single();
    }

    if (templateSaveResult.error) {
      setError(templateSaveResult.error.message);
      setSavingTemplate(false);
      return;
    }

    setSavingTemplate(false);
    setMessage(editingTemplateId ? '已更新习惯模板' : '已创建习惯模板');
    resetTemplateForm();
    await loadData();
    window.setTimeout(() => setMessage(''), 1500);
  };

  const startEditing = (template: HabitTemplateRow) => {
    setEditingTemplateId(template.id);
    const rule = template.frequency_rule ?? {};
    setTemplateForm({
      title: template.title,
      description: template.description ?? '',
      question: '',
      frequencyKind:
        typeof rule === 'object' &&
        rule !== null &&
        (rule as Record<string, unknown>).kind === 'monthly'
          ? 'monthly'
          : template.frequency_kind === 'custom'
            ? 'daily'
            : template.frequency_kind,
      every:
        typeof rule === 'object' && rule !== null
          ? String((rule as Record<string, unknown>).every ?? 1)
          : '1',
      unit:
        typeof rule === 'object' && rule !== null && (rule as Record<string, unknown>).unit
          ? ((rule as Record<string, unknown>).unit as 'day' | 'week' | 'month')
          : 'day',
      daysOfWeek:
        typeof rule === 'object' && rule !== null && Array.isArray((rule as Record<string, unknown>).daysOfWeek)
          ? ((rule as Record<string, unknown>).daysOfWeek as number[]).join(',')
          : '1,3,5',
      daysOfMonth:
        typeof rule === 'object' && rule !== null && Array.isArray((rule as Record<string, unknown>).daysOfMonth)
          ? ((rule as Record<string, unknown>).daysOfMonth as number[]).join(',')
          : '1',
      importance:
        typeof rule === 'object' && rule !== null && (rule as Record<string, unknown>).importance
          ? String((rule as Record<string, unknown>).importance)
          : '50',
      targetType: template.target_type === 'AT_MOST' ? 'AT_MOST' : 'AT_LEAST',
      targetValue: template.target_value !== null && template.target_value !== undefined ? String(template.target_value) : '',
      unitLabel: template.unit ?? '',
      color: '#2563eb',
      groupId: template.group_id ?? ''
    });
    setHabitModalOpen(true);
  };

  const toggleArchive = async (template: HabitTemplateRow) => {
    if (!user) {
      return;
    }

    const nextArchivedAt = template.archived_at ? null : new Date().toISOString();
    setError('');
    const { error: archiveError } = await supabase
      .from('habit_templates')
      .update({ archived_at: nextArchivedAt })
      .eq('id', template.id)
      .eq('user_id', user.id);

    if (archiveError) {
      setError(archiveError.message);
      return;
    }

    await loadData();
    setMessage(nextArchivedAt ? '已归档习惯模板' : '已恢复习惯模板');
    window.setTimeout(() => setMessage(''), 1500);
  };

  const deleteTemplate = async (template: HabitTemplateRow) => {
    if (!user) {
      return;
    }

    const confirmed = window.confirm(`确定删除习惯“${template.title}”吗？相关每日记录也会一起删除。`);
    if (!confirmed) {
      return;
    }

    setError('');
    setSavingRecordId(template.id);

    const { error: recordError } = await supabase
      .from('habit_daily_records')
      .delete()
      .eq('user_id', user.id)
      .eq('template_id', template.id);

    if (recordError) {
      setError(recordError.message);
      setSavingRecordId('');
      return;
    }

    const { error: templateError } = await supabase
      .from('habit_templates')
      .delete()
      .eq('id', template.id)
      .eq('user_id', user.id);

    if (templateError) {
      setError(templateError.message);
      setSavingRecordId('');
      return;
    }

    setSavingRecordId('');
    setMessage('已删除习惯及相关记录');
    await loadData();
    window.setTimeout(() => setMessage(''), 1500);
  };

  const saveRecord = async (template: HabitTemplateRow, draft: RecordDraftState) => {
    if (!user) {
      setError('请先登录');
      return;
    }

    setSavingRecordId(template.id);
    setError('');

    const valueNumber = draft.valueNumber.trim() ? Number(draft.valueNumber) : null;
    const valueText = draft.valueText.trim() || null;
    const draftRecord = {
      value_text: valueText,
      value_number: Number.isFinite(valueNumber ?? 0) && valueNumber !== null ? valueNumber : null,
      completion_state: 'unknown' as const,
      record_date: selectedDate
    };
    const evaluation = evaluateHabitRecord(template, draftRecord, selectedDate);
    const completionState = evaluation.isDone ? 'done' : 'missed';
    const normalizedValueNumber = isYesNoHabit(template)
      ? evaluation.actualValue
      : evaluation.actualValue;

    const payload = {
      user_id: user.id,
      template_id: template.id,
      record_date: selectedDate,
      value_text: isYesNoHabit(template) || valueNumber !== null ? null : valueText,
      value_number: normalizedValueNumber,
      completion_state: completionState,
      notes: draft.notes.trim() || null,
      source_type: 'manual',
      source_key: `manual-${template.id}-${selectedDate}`,
      raw_payload: {
        template_source_key: template.source_key,
        template_title: template.title,
        record_date: selectedDate,
        actual_value: evaluation.actualValue,
        completion_ratio: evaluation.completionRatio,
        score: evaluation.score
      }
    };

    const { error: recordError } = await supabase
      .from('habit_daily_records')
      .upsert(payload, { onConflict: 'user_id,template_id,record_date' });

    if (recordError) {
      setError(recordError.message);
      setSavingRecordId('');
      return;
    }

    setSavingRecordId('');
    setMessage('已保存打卡记录');
    await loadData();
    window.setTimeout(() => setMessage(''), 1500);
  };

  const deleteRecord = async (template: HabitTemplateRow) => {
    if (!user) {
      return;
    }

    setSavingRecordId(template.id);
    const { error: deleteError } = await supabase
      .from('habit_daily_records')
      .delete()
      .eq('user_id', user.id)
      .eq('template_id', template.id)
      .eq('record_date', selectedDate);

    if (deleteError) {
      setError(deleteError.message);
      setSavingRecordId('');
      return;
    }

    setSavingRecordId('');
    setMessage('已删除当天记录');
    await loadData();
    window.setTimeout(() => setMessage(''), 1500);
  };

  const currentDraft = (templateId: string) => recordDrafts[templateId] ?? createRecordDraft();
  const recordModalTemplate = recordModalTemplateId
    ? templates.find((template) => template.id === recordModalTemplateId) ?? null
    : null;
  const editingTemplate = editingTemplateId
    ? templates.find((template) => template.id === editingTemplateId) ?? null
    : null;
  const editingTemplateRecord = editingTemplate
    ? selectedDateRecords.find((record) => record.template_id === editingTemplate.id) ?? null
    : null;
  const editingTemplateEvaluation = editingTemplate
    ? evaluateHabitRecord(editingTemplate, editingTemplateRecord, selectedDate)
    : null;
  const selectedWeekDays = useMemo(
    () =>
      new Set(
        templateForm.daysOfWeek
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
      ),
    [templateForm.daysOfWeek]
  );
  const selectedMonthDays = useMemo(
    () =>
      new Set(
        templateForm.daysOfMonth
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value >= 1 && value <= 31)
      ),
    [templateForm.daysOfMonth]
  );
  const setWeekDays = (values: number[]) => {
    setTemplateForm((previous) => ({
      ...previous,
      daysOfWeek: values.sort((left, right) => left - right).join(',')
    }));
  };
  const setMonthDays = (values: number[]) => {
    setTemplateForm((previous) => ({
      ...previous,
      daysOfMonth: values.sort((left, right) => left - right).join(',')
    }));
  };

  return (
    <AppShell
      title='习惯管理'
      description='管理每日、每周和自定义频率的周期习惯，记录打卡，并为热力图和导入导出提供统一数据源。'
      activeHref='/habits'
      actions={
        <div className='flex flex-wrap items-center gap-2'>
          <button
            type='button'
            onClick={() => setSelectedDate(shiftDateInput(getBeijingDateInput(), -1))}
            className='rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
          >
            昨天
          </button>
          <button
            type='button'
            onClick={() => setSelectedDate(getBeijingDateInput())}
            className='rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
          >
            今天
          </button>
          <button
            type='button'
            onClick={() => setSelectedDate(shiftDateInput(getBeijingDateInput(), 1))}
            className='rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
          >
            明天
          </button>
          <button
            type='button'
            onClick={() => setSelectedDate(shiftDateInput(selectedDate, -1))}
            className='rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
          >
            前一天
          </button>
          <input
            type='date'
            value={selectedDate}
            onChange={(event) => setSelectedDate(clampDateInput(event.target.value))}
            className='min-w-40 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700'
          />
          <button
            type='button'
            onClick={() => setSelectedDate(shiftDateInput(selectedDate, 1))}
            className='rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
          >
            后一天
          </button>
        </div>
      }
      onSignOut={async () => {
        await supabase.auth.signOut();
        router.replace('/auth/login');
      }}
    >
      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-6'>
        <StatCard label='模板总数' value={stats.totalTemplates} hint='包含已归档习惯' />
        <StatCard label='活跃模板' value={stats.activeTemplates} hint='未归档的周期习惯' />
        <StatCard label='已归档' value={stats.archivedTemplates} hint='可随时恢复' />
        <StatCard label='记录总数' value={stats.recordsTotal} hint='最近 6 个月的每日记录' />
        <StatCard label='当天记录' value={stats.recordsToday} hint={`当前日期：${selectedDate}`} />
        <StatCard label='已完成' value={stats.completedToday} hint='完成或已记录的打卡' />
        <StatCard label='加权完成度' value={`${Math.round(stats.weightedCompletion * 100)}%`} hint='按习惯重要值加权' />
      </div>

      <Panel
        title='习惯'
        description='主体只保留紧凑列表；新建、编辑和每日记录都在弹窗中完成。'
        actions={
          <div className='flex flex-wrap gap-2'>
            <button
              type='button'
              onClick={() => {
                setEditingTemplateId(null);
                setTemplateForm(createHabitForm());
                setHabitModalOpen(true);
              }}
              className='rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white'
            >
              新建习惯
            </button>
            <button
              type='button'
              onClick={() => setGroupModalOpen(true)}
              className='rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700'
            >
              新建组
            </button>
          </div>
        }
      >
        {!groupsAvailable && (
          <p className='mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800'>
            习惯组结构尚未启用，执行 docs/sql/02_habits_import_export_schema.sql 后可保存习惯分组。
          </p>
        )}

        {groups.length > 0 && (
          <div className='mb-4'>
            <h3 className='text-sm font-semibold text-slate-900'>习惯组</h3>
            <div className='mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3'>
              {orderedGroups.map(({ group, level }) => {
                const item = habitGroupStats.get(group.id) ?? { total: 0, done: 0, allTemplates: 0, completion: 0, score: 0 };
                const isComplete = item.total > 0 && item.completion >= 1;
                return (
                  <Link
                    key={group.id}
                    href={`/habits/groups/${group.id}`}
                    className={`rounded-xl border p-3 text-left transition hover:border-slate-300 ${completionSurfaceClass(isComplete)}`}
                    style={{ marginLeft: level ? Math.min(level * 16, 48) : 0 }}
                  >
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <p className='font-medium text-slate-900'>{group.name}</p>
                      <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>分数 {item.score}</span>
                    </div>
                    <p className='mt-1 text-sm text-slate-500'>
                      应完成 {item.done}/{item.total} · 模板 {item.allTemplates} · 完成度 {Math.round(item.completion * 100)}%
                    </p>
                    {group.description && <p className='mt-1 text-sm text-slate-600'>{group.description}</p>}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-3'>
          {templates.map((template) => {
            const isArchived = Boolean(template.archived_at);
            const existingRecord = selectedDateRecords.find((record) => record.template_id === template.id);
            const evaluation = evaluateHabitRecord(template, existingRecord, selectedDate);
            const isComplete = evaluation.isDone;
            return (
              <div key={template.id} className={`rounded-xl border px-3 py-2 ${isArchived ? 'border-slate-200 bg-slate-50' : completionSurfaceClass(isComplete)}`}>
                <div className='flex items-center justify-between gap-2'>
                  <Link href={`/habits/${template.id}`} className='min-w-0 flex-1'>
                    <p className='truncate text-sm font-semibold text-slate-900'>{template.title}</p>
                    <p className='truncate text-xs text-slate-500'>
                      {frequencyBadgeLabel(template)} · 值 {formatHabitValue(evaluation.actualValue)} · 完成度 {evaluation.completionRatio}
                      {template.group_id && groupNameById.get(template.group_id) ? ` · ${groupNameById.get(template.group_id)}` : ''}
                    </p>
                  </Link>
                  <button
                    type='button'
                    onClick={() => setRecordModalTemplateId(template.id)}
                    className='rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs'
                  >
                    记录
                  </button>
                  <button
                    type='button'
                    onClick={() => startEditing(template)}
                    className='rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs'
                  >
                    编辑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className='grid gap-4 xl:grid-cols-[1.15fr_0.85fr]'>
        <Panel
          className={habitModalOpen ? 'fixed inset-4 z-50 overflow-y-auto border-slate-200 bg-white shadow-2xl md:inset-x-[12%] md:inset-y-8' : 'hidden'}
          title={editingTemplateId ? '编辑习惯模板' : '新建习惯模板'}
          description='先定义模板，再在任意日期为模板写入每日记录。频率规则使用可扩展 JSON 保存，方便后续导入导出。'
          actions={
            <button
              type='button'
              onClick={resetTemplateForm}
              className='rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm'
            >
              关闭
            </button>
          }
        >
          <form onSubmit={handleSubmitTemplate} className='grid gap-3 md:grid-cols-2'>
            {editingTemplate && editingTemplateEvaluation && (
              <div className={`md:col-span-2 rounded-2xl border px-4 py-3 ${
                editingTemplateEvaluation.isDone
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='text-sm font-semibold'>
                    当前状态：{editingTemplateEvaluation.isDone ? '已完成' : '未完成'}
                  </span>
                  <span className='rounded-full bg-white/80 px-3 py-1 text-xs font-semibold'>
                    完成度 {Math.round(editingTemplateEvaluation.completionRatio * 100)}%
                  </span>
                </div>
                <p className='mt-1 text-xs opacity-80'>
                  {selectedDate} · 实际值 {formatHabitValue(editingTemplateEvaluation.actualValue)}
                  {editingTemplate.target_value !== null && editingTemplate.target_value !== undefined ? ` · 目标 ${editingTemplate.target_value}` : ''}
                  {editingTemplateRecord ? ' · 已有记录' : ' · 无记录按 0'}
                </p>
              </div>
            )}

            <label className='block md:col-span-2'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>标题</span>
              <input
                value={templateForm.title}
                onChange={(event) =>
                  setTemplateForm((previous) => ({ ...previous, title: event.target.value }))
                }
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                placeholder='例如：早起 / 健身 / 每周复盘'
              />
            </label>

            <label className='block md:col-span-2'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>描述</span>
              <textarea
                value={templateForm.description}
                onChange={(event) =>
                  setTemplateForm((previous) => ({
                    ...previous,
                    description: event.target.value
                  }))
                }
                rows={2}
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                placeholder='补充这个习惯的使用说明'
              />
            </label>

            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>频率类型</span>
              <select
                value={templateForm.frequencyKind}
                onChange={(event) =>
                  setTemplateForm((previous) => ({
                    ...previous,
                    frequencyKind: event.target.value as HabitFormState['frequencyKind'],
                    unit: event.target.value === 'monthly' ? 'month' : event.target.value === 'weekly' ? 'week' : 'day'
                  }))
                }
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
              >
                <option value='daily'>每日</option>
                <option value='weekly'>每周</option>
                <option value='monthly'>每月</option>
              </select>
            </label>

            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>重要值</span>
              <input
                value={templateForm.importance}
                onChange={(event) =>
                  setTemplateForm((previous) => ({
                    ...previous,
                    importance: event.target.value
                  }))
                }
                type='number'
                min='1'
                max='100'
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                placeholder='1 到 100'
              />
            </label>

            {groupsAvailable && (
              <label className='block'>
                <span className='mb-1 block text-sm font-medium text-slate-600'>习惯组</span>
                <select
                  value={templateForm.groupId}
                  onChange={(event) =>
                    setTemplateForm((previous) => ({ ...previous, groupId: event.target.value }))
                  }
                  className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                >
                  {renderGroupOptions()}
                </select>
              </label>
            )}

            {templateForm.frequencyKind === 'weekly' && (
              <div className='md:col-span-2 rounded-2xl border border-slate-100 bg-slate-50 p-3'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='text-sm font-medium text-slate-600'>每周重复日</span>
                  <div className='flex flex-wrap gap-2'>
                    <button type='button' onClick={() => setWeekDays([0, 1, 2, 3, 4, 5, 6])} className='rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs'>全选</button>
                    <button type='button' onClick={() => setWeekDays([])} className='rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs'>全不选</button>
                    <button
                      type='button'
                      onClick={() => setWeekDays([0, 1, 2, 3, 4, 5, 6].filter((day) => !selectedWeekDays.has(day)))}
                      className='rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs'
                    >
                      反选
                    </button>
                  </div>
                </div>
                <div className='mt-3 grid grid-cols-4 gap-2 sm:grid-cols-7'>
                  {weekLabels.map((label, day) => (
                    <button
                      key={label}
                      type='button'
                      onClick={() => {
                        const next = new Set(selectedWeekDays);
                        if (next.has(day)) next.delete(day);
                        else next.add(day);
                        setWeekDays(Array.from(next));
                      }}
                      className={`rounded-xl px-3 py-2 text-sm ${selectedWeekDays.has(day) ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 border border-slate-200'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {templateForm.frequencyKind === 'monthly' && (
              <div className='md:col-span-2 rounded-2xl border border-slate-100 bg-slate-50 p-3'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='text-sm font-medium text-slate-600'>每月重复日期</span>
                  <div className='flex flex-wrap gap-2'>
                    <button type='button' onClick={() => setMonthDays(monthDays)} className='rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs'>全选</button>
                    <button type='button' onClick={() => setMonthDays([])} className='rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs'>全不选</button>
                    <button
                      type='button'
                      onClick={() => setMonthDays(monthDays.filter((day) => !selectedMonthDays.has(day)))}
                      className='rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs'
                    >
                      反选
                    </button>
                  </div>
                </div>
                <div className='mt-3 grid grid-cols-7 gap-2 sm:grid-cols-10'>
                  {monthDays.map((day) => (
                    <button
                      key={day}
                      type='button'
                      onClick={() => {
                        const next = new Set(selectedMonthDays);
                        if (next.has(day)) next.delete(day);
                        else next.add(day);
                        setMonthDays(Array.from(next));
                      }}
                      className={`rounded-xl px-2 py-2 text-sm ${selectedMonthDays.has(day) ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 border border-slate-200'}`}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>目标类型</span>
              <select
                value={templateForm.targetType}
                onChange={(event) =>
                  setTemplateForm((previous) => ({
                    ...previous,
                    targetType: event.target.value
                  }))
                }
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
              >
                <option value='AT_LEAST'>至少达到</option>
                <option value='AT_MOST'>不超过</option>
              </select>
            </label>

            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>目标值</span>
              <input
                value={templateForm.targetValue}
                onChange={(event) =>
                  setTemplateForm((previous) => ({
                    ...previous,
                    targetValue: event.target.value
                  }))
                }
                type='number'
                step='0.1'
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
              />
            </label>

            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-slate-600'>单位说明</span>
              <input
                value={templateForm.unitLabel}
                onChange={(event) =>
                  setTemplateForm((previous) => ({
                    ...previous,
                    unitLabel: event.target.value
                  }))
                }
                className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                placeholder='个 / 分钟 / 页'
              />
            </label>

            <div className='md:col-span-2 flex flex-wrap gap-3 pt-2'>
              <button
                type='submit'
                disabled={savingTemplate}
                className='rounded-2xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50'
              >
                {savingTemplate ? '保存中…' : editingTemplateId ? '更新模板' : '创建模板'}
              </button>
              <button
                type='button'
                onClick={resetTemplateForm}
                className='rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
              >
                清空
              </button>
            </div>
          </form>
        </Panel>

        {false && (
        <Panel
          className='hidden'
          title='当天打卡'
          description='在选中的日期为每个模板补数值；是否完成由目标规则自动判断。'
        >
          {loading && <p className='text-sm text-slate-500'>加载中…</p>}
          {!loading && !templates.length && (
            <div className='rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500'>
              还没有习惯模板，先创建一个吧。
            </div>
          )}

          <div className='space-y-3'>
            {templates.map((template) => {
              const draft = currentDraft(template.id);
              const isArchived = Boolean(template.archived_at);
              const existingRecord = selectedDateRecords.find((record) => record.template_id === template.id);
              const evaluation = evaluateHabitRecord(template, existingRecord, selectedDate);
              return (
                <div
                  key={template.id}
                  className={`rounded-3xl border p-4 ${isArchived ? 'border-slate-200 bg-slate-50/70' : 'border-slate-100 bg-white'}`}
                >
                  <div className='flex flex-wrap items-start justify-between gap-3'>
                    <div>
                      <div className='flex flex-wrap items-center gap-2'>
                        <h3 className='text-base font-semibold text-slate-900'>{template.title}</h3>
                        <span className='rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700'>
                          {frequencyBadgeLabel(template)}
                        </span>
                        {isArchived && (
                          <span className='rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600'>
                            已归档
                          </span>
                        )}
                      </div>
                      <p className='mt-1 text-sm text-slate-500'>{describeFrequency(template)}</p>
                      {template.question && (
                        <p className='mt-2 text-sm text-slate-700'>{template.question}</p>
                      )}
                    </div>

                    <div className='flex flex-wrap gap-2'>
                      <Link
                        href={`/habits/${template.id}`}
                        className='rounded-2xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
                      >
                        详情
                      </Link>
                      <button
                        type='button'
                        onClick={() => startEditing(template)}
                        className='rounded-2xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
                      >
                        编辑
                      </button>
                      <button
                        type='button'
                        onClick={() => toggleArchive(template)}
                        className='rounded-2xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
                      >
                        {isArchived ? '恢复' : '归档'}
                      </button>
                      <button
                        type='button'
                        onClick={() => deleteTemplate(template)}
                        disabled={savingRecordId === template.id}
                        className='rounded-2xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50'
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  <div className='mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3'>
                    <span className='rounded-xl bg-slate-50 px-3 py-2'>实际值：{formatHabitValue(evaluation.actualValue)}</span>
                    <span className='rounded-xl bg-slate-50 px-3 py-2'>完成度：{evaluation.completionRatio}</span>
                    <span className='rounded-xl bg-slate-50 px-3 py-2'>
                      {evaluation.isDone ? '已完成' : '未完成'}
                    </span>
                  </div>

                  <div className='mt-4 grid gap-3 lg:grid-cols-2'>
                    <label className='block'>
                      <span className='mb-1 block text-xs font-medium text-slate-500'>数值</span>
                      <input
                        value={draft.valueNumber}
                        onChange={(event) =>
                          setRecordDrafts((previous) => ({
                            ...previous,
                            [template.id]: {
                              ...draft,
                              valueNumber: event.target.value
                            }
                          }))
                        }
                        type='number'
                        step='0.1'
                        className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                        placeholder='可选'
                      />
                    </label>

                    <label className='block lg:col-span-2'>
                      <span className='mb-1 block text-xs font-medium text-slate-500'>文本值</span>
                      <input
                        value={draft.valueText}
                        onChange={(event) =>
                          setRecordDrafts((previous) => ({
                            ...previous,
                            [template.id]: {
                              ...draft,
                              valueText: event.target.value
                            }
                          }))
                        }
                        className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                        placeholder='YES_MANUAL / 1000 / 备注值'
                      />
                    </label>

                    <label className='block lg:col-span-2'>
                      <span className='mb-1 block text-xs font-medium text-slate-500'>备注</span>
                      <textarea
                        value={draft.notes}
                        onChange={(event) =>
                          setRecordDrafts((previous) => ({
                            ...previous,
                            [template.id]: {
                              ...draft,
                              notes: event.target.value
                            }
                          }))
                        }
                        rows={2}
                        className='w-full rounded-2xl border border-slate-200 px-3 py-2.5'
                        placeholder='补充今日说明'
                      />
                    </label>
                  </div>

                  <div className='mt-4 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      disabled={savingRecordId === template.id}
                      onClick={() => saveRecord(template, draft)}
                      className='rounded-2xl bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50'
                    >
                      {savingRecordId === template.id ? '保存中…' : '保存打卡'}
                    </button>
                    <button
                      type='button'
                      disabled={savingRecordId === template.id}
                      onClick={() => deleteRecord(template)}
                      className='rounded-2xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50'
                    >
                      删除当天记录
                    </button>
                  </div>

                  <p className='mt-3 text-xs text-slate-500'>
                    记录日期：{selectedDate}
                    {selectedDateRecords.find((record) => record.template_id === template.id) ? ' · 已有记录' : ' · 无记录，按 0 计算'}
                  </p>
                </div>
              );
            })}
          </div>
        </Panel>
        )}
      </div>

      {groupModalOpen && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
          <form onSubmit={createGroup} className='w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl'>
            <div className='mb-4 flex items-center justify-between gap-3'>
              <h2 className='text-lg font-semibold'>新建习惯组</h2>
              <button type='button' onClick={() => setGroupModalOpen(false)} className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'>关闭</button>
            </div>
            <div className='grid gap-3'>
              <label className='block'>
                <span className='mb-1 block text-sm text-slate-600'>组名</span>
                <input value={groupForm.name} onChange={(event) => setGroupForm((previous) => ({ ...previous, name: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2' />
              </label>
              <label className='block'>
                <span className='mb-1 block text-sm text-slate-600'>说明</span>
                <textarea value={groupForm.description} onChange={(event) => setGroupForm((previous) => ({ ...previous, description: event.target.value }))} rows={2} className='w-full rounded-lg border border-slate-200 p-2' />
              </label>
              <label className='block'>
                <span className='mb-1 block text-sm text-slate-600'>父组</span>
                <select value={groupForm.parentId} onChange={(event) => setGroupForm((previous) => ({ ...previous, parentId: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2'>
                  {renderGroupOptions('无父组')}
                </select>
              </label>
              <button type='submit' disabled={savingTemplate} className='rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50'>创建组</button>
            </div>
          </form>
        </div>
      )}

      {selectedGroup && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
          <div className='max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <h2 className='text-lg font-semibold text-slate-900'>{selectedGroup.name}</h2>
                <p className='mt-1 text-sm text-slate-500'>
                  {selectedDate} · 应完成 {selectedGroupStats.done}/{selectedGroupStats.total} · 模板 {selectedGroupStats.allTemplates} · 完成度 {Math.round(selectedGroupStats.completion * 100)}% · 分数 {selectedGroupStats.score}
                </p>
                {selectedGroup.description && <p className='mt-1 text-sm text-slate-600'>{selectedGroup.description}</p>}
              </div>
              <div className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  onClick={deleteSelectedGroup}
                  disabled={savingTemplate}
                  className='rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm text-rose-700 disabled:opacity-50'
                >
                  删除组
                </button>
                <button
                  type='button'
                  onClick={() => setSelectedGroupId(null)}
                  className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'
                >
                  关闭
                </button>
              </div>
            </div>

            {selectedGroupTimeline.length > 0 && (
              <div className='mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-4'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <h3 className='text-sm font-semibold text-slate-900'>最近 90 天</h3>
                  <span className='text-xs text-slate-500'>热力图是完成度，折线是分数</span>
                </div>
                <svg viewBox='0 0 100 38' className='mt-3 h-20 w-full overflow-visible'>
                  <line x1='0' y1='34' x2='100' y2='34' className='stroke-slate-200' strokeWidth='1' />
                  <polyline
                    points={selectedGroupScorePoints}
                    fill='none'
                    className='stroke-indigo-500'
                    strokeWidth='2.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  />
                </svg>
                <div className='mt-3 grid gap-1' style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(16px, 1fr))' }}>
                  {selectedGroupTimeline.map((item) => (
                    <div
                      key={item.date}
                      title={`${item.date} 完成度 ${Math.round(item.completion * 100)}% · 分数 ${item.score}`}
                      style={completionHeatmapStyle(item.completion * 100)}
                      className='aspect-square min-h-4 rounded-[4px]'
                    />
                  ))}
                </div>
              </div>
            )}

            {(groupChildren.get(selectedGroup.id) ?? []).length > 0 && (
              <div className='mt-5'>
                <h3 className='text-sm font-semibold text-slate-900'>子组</h3>
                <div className='mt-2 grid gap-2 sm:grid-cols-2'>
                  {(groupChildren.get(selectedGroup.id) ?? []).map((child) => {
                    const item = habitGroupStats.get(child.id) ?? { total: 0, done: 0, allTemplates: 0, completion: 0, score: 0 };
                    const isComplete = item.total > 0 && item.completion >= 1;
                    return (
                      <button
                        key={child.id}
                        type='button'
                        onClick={() => setSelectedGroupId(child.id)}
                        className={`rounded-xl border p-3 text-left transition hover:border-slate-300 ${completionSurfaceClass(isComplete)}`}
                      >
                        <p className='font-medium text-slate-900'>{child.name}</p>
                        <p className='mt-1 text-sm text-slate-500'>应完成 {item.done}/{item.total} · 完成度 {Math.round(item.completion * 100)}%</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className='mt-5'>
              <h3 className='text-sm font-semibold text-slate-900'>组内习惯</h3>
              <div className='mt-2 space-y-2'>
                {selectedGroupTemplates.length === 0 && (
                  <p className='rounded-xl bg-slate-50 p-3 text-sm text-slate-500'>这个组还没有习惯。</p>
                )}
                {selectedGroupTemplates.map((template) => {
                  const record = selectedDateRecords.find((item) => item.template_id === template.id);
                  const evaluation = evaluateHabitRecord(template, record, selectedDate);
                  const isComplete = evaluation.isDone;
                  return (
                    <button
                      key={template.id}
                      type='button'
                      onClick={() => {
                        setSelectedGroupId(null);
                        setRecordModalTemplateId(template.id);
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition hover:border-slate-300 ${completionSurfaceClass(isComplete)}`}
                    >
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <p className='font-medium text-slate-900'>{template.title}</p>
                        <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>
                          重要值 {habitImportance(template)} · 完成度 {Math.round(evaluation.completionRatio * 100)}%
                        </span>
                      </div>
                      <p className='mt-1 text-sm text-slate-500'>
                        {describeFrequency(template)} · 实际值 {formatHabitValue(evaluation.actualValue)}
                        {record ? ' · 已记录' : ' · 无记录按 0'}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {recordModalTemplate && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
          <div className='w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl'>
            {(() => {
              const draft = currentDraft(recordModalTemplate.id);
              const existingRecord = selectedDateRecords.find((record) => record.template_id === recordModalTemplate.id);
              const evaluation = evaluateHabitRecord(recordModalTemplate, existingRecord, selectedDate);
              return (
                <>
                  <div className='flex items-center justify-between gap-3'>
                    <div>
                      <h2 className='text-lg font-semibold'>{recordModalTemplate.title}</h2>
                    </div>
                    <button
                      type='button'
                      onClick={() => setRecordModalTemplateId(null)}
                      className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'
                    >
                      关闭
                    </button>
                  </div>

                  <div className={`mt-4 rounded-2xl border px-4 py-3 ${
                    evaluation.isDone
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                      : 'border-amber-200 bg-amber-50 text-amber-900'
                  }`}>
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <span className='text-sm font-semibold'>当前状态：{evaluation.isDone ? '已完成' : '未完成'}</span>
                      <span className='rounded-full bg-white/80 px-3 py-1 text-xs font-semibold'>
                        完成度 {Math.round(evaluation.completionRatio * 100)}%
                      </span>
                    </div>
                    <p className='mt-1 text-xs opacity-80'>
                      {selectedDate} · 当前值 {formatHabitValue(evaluation.actualValue)}
                      {existingRecord ? ' · 已有记录' : ' · 无记录按 0'}
                    </p>
                  </div>

                  <div className='mt-4 grid gap-3 sm:grid-cols-2'>
                    <label className='block'>
                      <span className='mb-1 block text-xs font-medium text-slate-500'>数值</span>
                      <input
                        value={draft.valueNumber}
                        onChange={(event) =>
                          setRecordDrafts((previous) => ({
                            ...previous,
                            [recordModalTemplate.id]: {
                              ...draft,
                              valueNumber: event.target.value
                            }
                          }))
                        }
                        type='number'
                        step='0.1'
                        className='w-full rounded-xl border border-slate-200 px-3 py-2.5'
                      />
                    </label>

                    <label className='block sm:col-span-2'>
                      <span className='mb-1 block text-xs font-medium text-slate-500'>备注</span>
                      <textarea
                        value={draft.notes}
                        onChange={(event) =>
                          setRecordDrafts((previous) => ({
                            ...previous,
                            [recordModalTemplate.id]: {
                              ...draft,
                              notes: event.target.value
                            }
                          }))
                        }
                        rows={3}
                        className='w-full rounded-xl border border-slate-200 px-3 py-2.5'
                        placeholder='补充今日说明'
                      />
                    </label>
                  </div>

                  <div className='mt-4 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      disabled={savingRecordId === recordModalTemplate.id}
                      onClick={async () => {
                        await saveRecord(recordModalTemplate, draft);
                        setRecordModalTemplateId(null);
                      }}
                      className='rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
                    >
                      保存记录
                    </button>
                    <button
                      type='button'
                      disabled={savingRecordId === recordModalTemplate.id}
                      onClick={async () => {
                        await deleteRecord(recordModalTemplate);
                        setRecordModalTemplateId(null);
                      }}
                      className='rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 disabled:opacity-50'
                    >
                      删除当天记录
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {message && <p className='rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700'>{message}</p>}
      {error && <p className='rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700'>{error}</p>}
    </AppShell>
  );
}
