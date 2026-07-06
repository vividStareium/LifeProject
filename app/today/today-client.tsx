'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase/client';
import { isRangeTask, taskCompletionRatio, taskEffectiveWeight, taskRangeEnd, taskRangeStart } from '@/lib/analytics';
import { clampDateInput, formatDateLabel, getBeijingDateInput, shiftDateInput } from '@/lib/date';
import type { TaskGroupRow, TaskPriority, TaskRow, TaskType } from '@/types/task';

type TaskFormState = {
  title: string;
  description: string;
  taskType: TaskType;
  taskDate: string;
  rangeStartDate: string;
  rangeEndDate: string;
  progressValue: string;
  targetValue: string;
  startTime: string;
  endTime: string;
  priority: TaskPriority;
  importance: string;
  category: string;
  groupId: string;
};

type TaskTemplate = {
  id: string;
  name: string;
  offsets: number[];
  builtin?: boolean;
};

type BatchFormState = {
  templateId: string;
  title: string;
  description: string;
  startDate: string;
  priority: TaskPriority;
  importance: string;
  groupName: string;
  parentGroupId: string;
};

type GroupFormState = {
  name: string;
  description: string;
  parentId: string;
};

const builtinTemplates: TaskTemplate[] = [
  { id: 'three-days', name: '连续三天', offsets: [0, 1, 2], builtin: true },
  { id: 'one-week', name: '连续一周', offsets: [0, 1, 2, 3, 4, 5, 6], builtin: true },
  { id: 'one-month', name: '连续一个月', offsets: Array.from({ length: 30 }, (_, index) => index), builtin: true },
  { id: 'ebbinghaus', name: '艾宾浩斯记忆法', offsets: [0, 1, 2, 4, 7, 15, 30], builtin: true }
];

const defaultTaskForm = (date: string): TaskFormState => ({
  title: '',
  description: '',
  taskType: 'single',
  taskDate: date,
  rangeStartDate: date,
  rangeEndDate: date,
  progressValue: '',
  targetValue: '',
  startTime: '',
  endTime: '',
  priority: 'medium',
  importance: '50',
  category: '',
  groupId: ''
});

const defaultBatchForm = (date: string): BatchFormState => ({
  templateId: builtinTemplates[0].id,
  title: '',
  description: '',
  startDate: date,
  priority: 'medium',
  importance: '50',
  groupName: '',
  parentGroupId: ''
});

const defaultGroupForm = (): GroupFormState => ({
  name: '',
  description: '',
  parentId: ''
});

const isSchemaError = (message: string) => {
  const lower = message.toLowerCase();
  return (
    lower.includes('schema cache') ||
    lower.includes('does not exist') ||
    lower.includes('column') ||
    lower.includes('relation')
  );
};

const clampImportance = (value: string) => Math.min(100, Math.max(1, Number(value) || 50));

const nullableNumber = (value: string) => {
  const number = Number(value);
  return value.trim() && Number.isFinite(number) ? number : null;
};

const completionSurfaceClass = (isComplete: boolean) =>
  isComplete
    ? 'border-emerald-200 bg-gradient-to-r from-emerald-100 via-white to-white'
    : 'border-slate-100 bg-slate-50';

const parseOffsets = (value: string) =>
  Array.from(
    new Set(
      value
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isInteger(item) && item >= 0 && item <= 365)
    )
  ).sort((left, right) => left - right);

const omitKeys = <T extends Record<string, unknown>>(value: T, keys: string[]) => {
  const next = { ...value };
  for (const key of keys) {
    delete next[key];
  }
  return next;
};

export default function TodayClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedDate = clampDateInput(searchParams.get('date'));

  const [user, setUser] = useState<User | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [groups, setGroups] = useState<TaskGroupRow[]>([]);
  const [groupsAvailable, setGroupsAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loadingActionId, setLoadingActionId] = useState<string>('');
  const [submitLoading, setSubmitLoading] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);
  const [customTemplates, setCustomTemplates] = useState<TaskTemplate[]>([]);
  const [customTemplateName, setCustomTemplateName] = useState('');
  const [customTemplateOffsets, setCustomTemplateOffsets] = useState('0,1,3');
  const [taskProgressDrafts, setTaskProgressDrafts] = useState<Record<string, string>>({});

  const [form, setForm] = useState<TaskFormState>(() => defaultTaskForm(selectedDate));
  const [batchForm, setBatchForm] = useState<BatchFormState>(() => defaultBatchForm(selectedDate));
  const [groupForm, setGroupForm] = useState<GroupFormState>(() => defaultGroupForm());

  const templateStorageKey = user ? `lifeproject.taskTemplates.${user.id}` : '';
  const taskTemplates = useMemo(
    () => [...builtinTemplates, ...customTemplates],
    [customTemplates]
  );

  const orderedGroups = useMemo(() => {
    const children = new Map<string, TaskGroupRow[]>();
    const existingIds = new Set(groups.map((group) => group.id));
    for (const group of groups) {
      const parentId = group.parent_id && existingIds.has(group.parent_id) ? group.parent_id : 'root';
      const list = children.get(parentId) ?? [];
      list.push(group);
      children.set(parentId, list);
    }

    const result: Array<{ group: TaskGroupRow; level: number }> = [];
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
    const children = new Map<string, TaskGroupRow[]>();
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

  const updateDate = useCallback(
    (date: string) => {
      const nextSearch = new URLSearchParams(searchParams.toString());
      nextSearch.set('date', date);
      router.push(`${pathname}?${nextSearch.toString()}`);
    },
    [pathname, router, searchParams]
  );

  const fetchGroups = useCallback(async (userId: string) => {
    const { data, error: groupError } = await supabase
      .from('task_groups')
      .select('id,user_id,parent_id,name,description,color,created_at,updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (groupError) {
      setGroups([]);
      setGroupsAvailable(false);
      return;
    }

    setGroups((data ?? []) as unknown as TaskGroupRow[]);
    setGroupsAvailable(true);
  }, []);

  const fetchTasks = useCallback(async (userId: string, date: string) => {
    setLoading(true);
    setError('');

    const buildQuery = (selectFields: string) => supabase
      .from('tasks')
      .select(selectFields)
      .eq('user_id', userId)
      .is('deleted_at', null);

    const finishQuery = (query: ReturnType<typeof buildQuery>, includeRange: boolean) => {
      const filtered = includeRange
        ? query.or(`task_date.eq.${date},and(task_type.eq.range,range_start_date.lte.${date},range_end_date.gte.${date})`)
        : query.eq('task_date', date);

      return filtered.order('start_time', {
        ascending: true,
        nullsFirst: false
      });
    };

    const attempts = [
      {
        fields: 'id,user_id,title,description,task_date,task_type,range_start_date,range_end_date,progress_value,target_value,start_time,end_time,status,priority,importance,category,group_id,created_at,updated_at,deleted_at',
        hasGroups: true,
        includeRange: true
      },
      {
        fields: 'id,user_id,title,description,task_date,task_type,range_start_date,range_end_date,progress_value,target_value,start_time,end_time,status,priority,importance,category,created_at,updated_at,deleted_at',
        hasGroups: false,
        includeRange: true
      },
      {
        fields: 'id,user_id,title,description,task_date,start_time,end_time,status,priority,importance,category,group_id,created_at,updated_at,deleted_at',
        hasGroups: true
      },
      {
        fields: 'id,user_id,title,description,task_date,start_time,end_time,status,priority,category,group_id,created_at,updated_at,deleted_at',
        hasGroups: true
      },
      {
        fields: 'id,user_id,title,description,task_date,start_time,end_time,status,priority,importance,category,created_at,updated_at,deleted_at',
        hasGroups: false
      },
      {
        fields: 'id,user_id,title,description,task_date,start_time,end_time,status,priority,category,created_at,updated_at,deleted_at',
        hasGroups: false
      }
    ];

    for (const attempt of attempts) {
      const { data, error: taskError } = await finishQuery(buildQuery(attempt.fields), Boolean(attempt.includeRange));
      if (!taskError) {
        setTasks((data || []) as unknown as TaskRow[]);
        if (!attempt.hasGroups) {
          setGroupsAvailable(false);
        }
        setLoading(false);
        return;
      }

      if (!isSchemaError(taskError.message)) {
        setError(taskError.message);
        setTasks([]);
        setLoading(false);
        return;
      }
    }

    setError('读取任务失败，请检查数据库结构。');
    setTasks([]);
    setLoading(false);
  }, []);

  const loadUserAndTasks = useCallback(async () => {
    const {
      data: { user: currentUser }
    } = await supabase.auth.getUser();

    if (!currentUser) {
      router.replace('/auth/login');
      return;
    }

    setUser(currentUser);
    setForm((previous) => ({ ...previous, taskDate: selectedDate }));
    setBatchForm((previous) => ({ ...previous, startDate: selectedDate }));
    await Promise.all([fetchGroups(currentUser.id), fetchTasks(currentUser.id, selectedDate)]);
  }, [fetchGroups, fetchTasks, router, selectedDate]);

  useEffect(() => {
    loadUserAndTasks();
  }, [loadUserAndTasks]);

  useEffect(() => {
    if (!templateStorageKey) return;
    const stored = window.localStorage.getItem(templateStorageKey);
    if (!stored) {
      setCustomTemplates([]);
      return;
    }

    try {
      const parsed = JSON.parse(stored) as TaskTemplate[];
      setCustomTemplates(
        parsed.filter((item) => item.id && item.name && Array.isArray(item.offsets))
      );
    } catch {
      setCustomTemplates([]);
    }
  }, [templateStorageKey]);

  const saveCustomTemplates = (nextTemplates: TaskTemplate[]) => {
    setCustomTemplates(nextTemplates);
    if (templateStorageKey) {
      window.localStorage.setItem(templateStorageKey, JSON.stringify(nextTemplates));
    }
  };

  const stats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((task) => taskCompletionRatio(task) >= 1).length;
    const totalWeight = tasks.reduce((sum, task) => sum + taskEffectiveWeight(task, selectedDate), 0);
    const weightedCompletion = totalWeight > 0
      ? tasks.reduce((sum, task) => sum + taskCompletionRatio(task) * taskEffectiveWeight(task, selectedDate), 0) / totalWeight
      : 0;

    return {
      total,
      done,
      undone: total - done,
      weightedCompletion
    };
  }, [selectedDate, tasks]);

  const groupStats = useMemo(() => {
    return new Map(
      groups.map((group) => {
        const ids = groupIdsById.get(group.id) ?? new Set([group.id]);
        const groupTasks = tasks.filter((task) => task.group_id && ids.has(task.group_id));
        const totalWeight = groupTasks.reduce((sum, task) => sum + taskEffectiveWeight(task, selectedDate), 0);
        const completion = totalWeight > 0
          ? groupTasks.reduce((sum, task) => sum + taskCompletionRatio(task) * taskEffectiveWeight(task, selectedDate), 0) / totalWeight
          : 0;
        return [group.id, {
          total: groupTasks.length,
          done: groupTasks.filter((task) => taskCompletionRatio(task) >= 1).length,
          completion,
          score: Math.round(completion * 100)
        }];
      })
    );
  }, [groupIdsById, groups, selectedDate, tasks]);

  const selectedGroup = selectedGroupId
    ? groups.find((group) => group.id === selectedGroupId) ?? null
    : null;
  const selectedGroupIds = selectedGroupId ? groupIdsById.get(selectedGroupId) ?? new Set([selectedGroupId]) : new Set<string>();
  const selectedGroupTasks = selectedGroup
    ? tasks.filter((task) => task.group_id && selectedGroupIds.has(task.group_id))
    : [];
  const selectedGroupStats = selectedGroupId
    ? groupStats.get(selectedGroupId) ?? { total: 0, done: 0, completion: 0, score: 0 }
    : { total: 0, done: 0, completion: 0, score: 0 };

  const runTaskMutation = async (
    payload: Record<string, unknown>,
    taskId?: string
  ) => {
    const attempts = [
      payload,
      omitKeys(payload, ['group_id']),
      omitKeys(payload, ['importance']),
      omitKeys(payload, ['task_type', 'range_start_date', 'range_end_date', 'progress_value', 'target_value']),
      omitKeys(payload, ['group_id', 'importance', 'task_type', 'range_start_date', 'range_end_date', 'progress_value', 'target_value'])
    ];

    for (const attempt of attempts) {
      const result = taskId
        ? await supabase.from('tasks').update(attempt).eq('id', taskId).eq('user_id', user?.id)
        : await supabase.from('tasks').insert([attempt]);

      if (!result.error) {
        return '';
      }

      if (!isSchemaError(result.error.message)) {
        return result.error.message;
      }
    }

    return '保存任务失败，请检查数据库结构。';
  };

  const insertTaskRows = async (rows: Array<Record<string, unknown>>) => {
    const attempts = [
      rows,
      rows.map((row) => omitKeys(row, ['group_id'])),
      rows.map((row) => omitKeys(row, ['importance'])),
      rows.map((row) => omitKeys(row, ['task_type', 'range_start_date', 'range_end_date', 'progress_value', 'target_value'])),
      rows.map((row) => omitKeys(row, ['group_id', 'importance', 'task_type', 'range_start_date', 'range_end_date', 'progress_value', 'target_value']))
    ];

    for (const attempt of attempts) {
      const result = await supabase.from('tasks').insert(attempt);
      if (!result.error) {
        return '';
      }

      if (!isSchemaError(result.error.message)) {
        return result.error.message;
      }
    }

    return '批量创建任务失败，请检查数据库结构。';
  };

  const createGroup = async (name: string, description: string, parentId: string) => {
    if (!user || !groupsAvailable) {
      return null;
    }

    const { data, error: groupError } = await supabase
      .from('task_groups')
      .insert([{
        user_id: user.id,
        name,
        description: description.trim() || null,
        parent_id: parentId || null
      }])
      .select('id')
      .single();

    if (groupError) {
      if (isSchemaError(groupError.message)) {
        setGroupsAvailable(false);
        return null;
      }
      throw new Error(groupError.message);
    }

    return (data as { id: string } | null)?.id ?? null;
  };

  const resetTaskForm = () => {
    setEditingTask(null);
    setForm(defaultTaskForm(selectedDate));
  };

  const openCreateTaskModal = () => {
    resetTaskForm();
    setTaskModalOpen(true);
  };

  const openEditTaskModal = (task: TaskRow) => {
    setEditingTask(task);
    setForm({
      title: task.title,
      description: task.description ?? '',
      taskType: isRangeTask(task) ? 'range' : 'single',
      taskDate: task.task_date,
      rangeStartDate: taskRangeStart(task),
      rangeEndDate: taskRangeEnd(task),
      progressValue: task.progress_value == null ? '' : String(task.progress_value),
      targetValue: task.target_value == null ? '' : String(task.target_value),
      startTime: task.start_time?.slice(0, 5) ?? '',
      endTime: task.end_time?.slice(0, 5) ?? '',
      priority: task.priority,
      importance: String(task.importance ?? 50),
      category: task.category ?? '',
      groupId: task.group_id ?? ''
    });
    setTaskModalOpen(true);
  };

  const handleSaveTask = async (event: FormEvent) => {
    event.preventDefault();

    if (!user) {
      setError('请先登录');
      return;
    }

    if (!form.title.trim()) {
      setError('标题不能为空');
      return;
    }

    if (form.startTime && form.endTime && form.startTime >= form.endTime) {
      setError('结束时间必须晚于开始时间');
      return;
    }

    if (form.taskType === 'range' && form.rangeStartDate > form.rangeEndDate) {
      setError('区间任务的截止日期不能早于开始日期');
      return;
    }

    setSubmitLoading(true);
    setError('');
    const progressValue = nullableNumber(form.progressValue);
    const targetValue = nullableNumber(form.targetValue);
    const isRange = form.taskType === 'range';

    const payload = {
      user_id: user.id,
      title: form.title.trim(),
      description: form.description.trim() || null,
      task_date: isRange ? form.rangeStartDate : form.taskDate,
      task_type: form.taskType,
      range_start_date: isRange ? form.rangeStartDate : null,
      range_end_date: isRange ? form.rangeEndDate : null,
      progress_value: progressValue,
      target_value: targetValue,
      start_time: isRange ? null : form.startTime || null,
      end_time: isRange ? null : form.endTime || null,
      priority: 'medium',
      importance: clampImportance(form.importance),
      category: null,
      group_id: form.groupId || null,
      status: 'todo'
    };
    const saveError = await runTaskMutation(payload, editingTask?.id);

    if (saveError) {
      setError(saveError);
      setSubmitLoading(false);
      return;
    }

    setTaskModalOpen(false);
    resetTaskForm();
    await fetchTasks(user.id, selectedDate);
    setSubmitLoading(false);
    setMessage(editingTask ? '已更新任务' : '已新增任务');
    window.setTimeout(() => setMessage(''), 1200);
  };

  const handleCreateGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) {
      setError('请先登录');
      return;
    }

    if (!groupForm.name.trim()) {
      setError('组名不能为空');
      return;
    }

    setSubmitLoading(true);
    setError('');

    try {
      const groupId = await createGroup(groupForm.name.trim(), groupForm.description, groupForm.parentId);
      if (!groupId) {
        setError('数据库还没有启用任务组，请先执行 docs/sql/01_tasks_schema.sql。');
      } else {
        setGroupModalOpen(false);
        setGroupForm(defaultGroupForm());
        await fetchGroups(user.id);
        setMessage('已创建任务组');
        window.setTimeout(() => setMessage(''), 1200);
      }
    } catch (groupError) {
      setError(groupError instanceof Error ? groupError.message : '创建任务组失败');
    }

    setSubmitLoading(false);
  };

  const handleCreateTemplate = () => {
    const offsets = parseOffsets(customTemplateOffsets);
    if (!customTemplateName.trim() || !offsets.length) {
      setError('自定义模板需要名称和至少一个有效天数。');
      return;
    }

    const nextTemplates = [
      ...customTemplates,
      {
        id: `custom-${crypto.randomUUID()}`,
        name: customTemplateName.trim(),
        offsets
      }
    ];
    saveCustomTemplates(nextTemplates);
    setCustomTemplateName('');
    setCustomTemplateOffsets('0,1,3');
    setError('');
  };

  const deleteCustomTemplate = (templateId: string) => {
    saveCustomTemplates(customTemplates.filter((template) => template.id !== templateId));
  };

  const handleBatchCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) {
      setError('请先登录');
      return;
    }

    const template = taskTemplates.find((item) => item.id === batchForm.templateId);
    if (!template) {
      setError('请选择任务模板');
      return;
    }

    if (!batchForm.title.trim()) {
      setError('任务名称不能为空');
      return;
    }

    setSubmitLoading(true);
    setError('');

    let groupId: string | null = null;
    try {
      groupId = await createGroup(
        batchForm.groupName.trim() || `${batchForm.title.trim()} · ${template.name}`,
        batchForm.description,
        batchForm.parentGroupId
      );
    } catch (groupError) {
      setError(groupError instanceof Error ? groupError.message : '创建模板任务组失败');
      setSubmitLoading(false);
      return;
    }

    const rows = template.offsets.map((offset) => ({
      user_id: user.id,
      title: batchForm.title.trim(),
      description: batchForm.description.trim() || null,
      task_date: shiftDateInput(batchForm.startDate, offset),
      task_type: 'single',
      range_start_date: null,
      range_end_date: null,
      progress_value: null,
      target_value: null,
      start_time: null,
      end_time: null,
      priority: 'medium',
      importance: clampImportance(batchForm.importance),
      category: null,
      group_id: groupId,
      status: 'todo'
    }));
    const insertError = await insertTaskRows(rows);

    if (insertError) {
      setError(insertError);
      setSubmitLoading(false);
      return;
    }

    setBatchModalOpen(false);
    setBatchForm(defaultBatchForm(selectedDate));
    await Promise.all([fetchGroups(user.id), fetchTasks(user.id, selectedDate)]);
    setSubmitLoading(false);
    setMessage(groupId ? '已按模板创建任务，并放入同一任务组' : '已按模板创建任务；执行任务组 SQL 后可自动分组');
    window.setTimeout(() => setMessage(''), 1600);
  };

  const saveTaskProgress = async (task: TaskRow) => {
    if (!user) {
      setError('请先登录');
      return;
    }

    const draft = taskProgressDrafts[task.id] ?? (task.progress_value == null ? '' : String(task.progress_value));
    const progressValue = nullableNumber(draft);
    setLoadingActionId(task.id);
    const { error: updateError } = await supabase
      .from('tasks')
      .update({
        progress_value: progressValue,
        status: 'todo',
        updated_at: new Date().toISOString()
      })
      .eq('id', task.id)
      .eq('user_id', user.id);

    if (updateError) {
      setError(updateError.message);
    } else {
      await fetchTasks(user.id, selectedDate);
      setMessage('已保存任务数值');
      window.setTimeout(() => setMessage(''), 1200);
    }

    setLoadingActionId('');
  };

  const softDeleteTask = async (task: TaskRow) => {
    if (!user) {
      setError('请先登录');
      return;
    }

    if (!window.confirm(`确定删除任务“${task.title}”吗？`)) {
      return;
    }

    setLoadingActionId(task.id);
    const { error: softDeleteError } = await supabase
      .from('tasks')
      .update({
        status: 'cancelled',
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', task.id)
      .eq('user_id', user.id);

    let deleteError = softDeleteError;
    if (softDeleteError && softDeleteError.message.toLowerCase().includes('row-level security')) {
      const hardDeleteResult = await supabase
        .from('tasks')
        .delete()
        .eq('id', task.id)
        .eq('user_id', user.id);
      deleteError = hardDeleteResult.error;
    }

    if (deleteError) {
      setError(deleteError.message);
    } else {
      await fetchTasks(user.id, selectedDate);
    }

    setLoadingActionId('');
  };

  const deleteSelectedGroup = async () => {
    if (!user || !selectedGroup) {
      return;
    }

    if (!window.confirm(`确定删除任务组“${selectedGroup.name}”吗？组内任务不会被删除，只会移出该组。`)) {
      return;
    }

    setSubmitLoading(true);
    setError('');

    const { error: taskUpdateError } = await supabase
      .from('tasks')
      .update({ group_id: null, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('group_id', selectedGroup.id);

    if (taskUpdateError) {
      setError(taskUpdateError.message);
      setSubmitLoading(false);
      return;
    }

    const { error: childUpdateError } = await supabase
      .from('task_groups')
      .update({ parent_id: null })
      .eq('user_id', user.id)
      .eq('parent_id', selectedGroup.id);

    if (childUpdateError) {
      setError(childUpdateError.message);
      setSubmitLoading(false);
      return;
    }

    const { error: groupDeleteError } = await supabase
      .from('task_groups')
      .delete()
      .eq('id', selectedGroup.id)
      .eq('user_id', user.id);

    if (groupDeleteError) {
      setError(groupDeleteError.message);
      setSubmitLoading(false);
      return;
    }

    setSelectedGroupId(null);
    await Promise.all([fetchGroups(user.id), fetchTasks(user.id, selectedDate)]);
    setSubmitLoading(false);
    setMessage('已删除任务组，组内任务已移出该组');
    window.setTimeout(() => setMessage(''), 1500);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    router.replace('/auth/login');
  };

  const onDateInputChange = (value: string) => {
    updateDate(clampDateInput(value));
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

  const formTargetNumber = Number(form.targetValue);
  const formProgressNumber = Number(form.progressValue);
  const formCompletionRatio = formTargetNumber > 0
    ? Math.min(1, Math.max(0, (Number.isFinite(formProgressNumber) ? formProgressNumber : 0) / formTargetNumber))
    : 0;
  const formStatusText = formCompletionRatio >= 1 ? '进度已达标' : '未完成';

  return (
    <main className='min-h-screen bg-slate-100 p-4'>
      <div className='mx-auto flex w-full max-w-6xl flex-col gap-4'>
        <header className='rounded-2xl bg-white p-4 shadow-sm'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <h1 className='text-2xl font-bold'>Life Project</h1>
              <p className='text-sm text-slate-500'>任务 · {formatDateLabel(selectedDate)}</p>
            </div>

            <button
              type='button'
              onClick={signOut}
              className='rounded-lg bg-slate-900 px-4 py-2 text-sm text-white'
            >
              退出登录
            </button>
          </div>
          <div className='mt-3 flex flex-wrap gap-2 text-sm'>
            <Link href='/today' className='rounded-full bg-slate-900 px-3 py-1.5 text-white'>今日</Link>
            <Link href='/habits' className='rounded-full bg-slate-100 px-3 py-1.5 text-slate-700'>习惯</Link>
            <Link href='/heatmap' className='rounded-full bg-slate-100 px-3 py-1.5 text-slate-700'>热力图</Link>
            <Link href='/import' className='rounded-full bg-slate-100 px-3 py-1.5 text-slate-700'>导入</Link>
            <Link href='/export' className='rounded-full bg-slate-100 px-3 py-1.5 text-slate-700'>导出</Link>
          </div>
          <div className='mt-4 grid gap-2 sm:flex sm:flex-wrap sm:items-center'>
            <button type='button' onClick={() => updateDate(getBeijingDateInput())} className='rounded-lg border border-slate-200 px-3 py-2'>今天</button>
            <button type='button' onClick={() => updateDate(shiftDateInput(selectedDate, -1))} className='rounded-lg border border-slate-200 px-3 py-2'>前一天</button>
            <input type='date' value={selectedDate} onChange={(event) => onDateInputChange(event.target.value)} className='rounded-lg border border-slate-200 p-2 sm:min-w-44' />
            <button type='button' onClick={() => updateDate(shiftDateInput(selectedDate, 1))} className='rounded-lg border border-slate-200 px-3 py-2'>后一天</button>
          </div>
        </header>

        <section className='rounded-2xl bg-white p-4 shadow-sm'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <h2 className='text-lg font-semibold'>任务</h2>
              <p className='text-sm text-slate-500'>单个任务、批量模板和任务组都在这里管理。</p>
            </div>
            <div className='flex flex-wrap gap-2'>
              <button type='button' onClick={openCreateTaskModal} className='rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white'>新增任务</button>
              <button type='button' onClick={() => setBatchModalOpen(true)} className='rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700'>高级任务</button>
              <button type='button' onClick={() => setGroupModalOpen(true)} className='rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700'>新建组</button>
            </div>
          </div>
          {!groupsAvailable && (
            <p className='mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800'>
              任务组结构尚未启用，执行 docs/sql/01_tasks_schema.sql 后可保存分组和模板组。
            </p>
          )}
          {error && <p className='mt-2 text-sm text-rose-600'>{error}</p>}
          {message && <p className='mt-2 text-sm text-emerald-700'>{message}</p>}
        </section>

        <section className='grid gap-3 md:grid-cols-4'>
          <div className='rounded-2xl bg-white p-4 shadow-sm'>
            <p className='text-sm text-slate-500'>任务总数</p>
            <p className='mt-2 text-3xl font-semibold'>{stats.total}</p>
          </div>
          <div className='rounded-2xl bg-white p-4 shadow-sm'>
            <p className='text-sm text-slate-500'>已完成</p>
            <p className='mt-2 text-3xl font-semibold'>{stats.done}</p>
          </div>
          <div className='rounded-2xl bg-white p-4 shadow-sm'>
            <p className='text-sm text-slate-500'>未完成</p>
            <p className='mt-2 text-3xl font-semibold'>{stats.undone}</p>
          </div>
          <div className='rounded-2xl bg-white p-4 shadow-sm'>
            <p className='text-sm text-slate-500'>加权完成度</p>
            <p className='mt-2 text-3xl font-semibold'>{Math.round(stats.weightedCompletion * 100)}%</p>
          </div>
        </section>

        {groups.length > 0 && (
          <section className='rounded-2xl bg-white p-4 shadow-sm'>
            <h2 className='text-lg font-semibold'>任务组</h2>
            <div className='mt-3 grid gap-2 md:grid-cols-2'>
              {orderedGroups.map(({ group, level }) => {
                const item = groupStats.get(group.id) ?? { total: 0, done: 0, completion: 0, score: 0 };
                const isComplete = item.total > 0 && item.completion >= 1;
                return (
                  <button
                    key={group.id}
                    type='button'
                    onClick={() => setSelectedGroupId(group.id)}
                    className={`rounded-xl border p-3 text-left transition hover:border-slate-300 ${completionSurfaceClass(isComplete)}`}
                    style={{ marginLeft: level ? Math.min(level * 16, 48) : 0 }}
                  >
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <p className='font-medium text-slate-900'>{group.name}</p>
                      <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>分数 {item.score}</span>
                    </div>
                    <p className='mt-1 text-sm text-slate-500'>
                      完成 {item.done}/{item.total} · 完成度 {Math.round(item.completion * 100)}%
                    </p>
                    {group.description && <p className='mt-1 text-sm text-slate-600'>{group.description}</p>}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className='rounded-2xl bg-white p-4 shadow-sm'>
          <h2 className='text-lg font-semibold'>任务列表</h2>
          {loading && <p className='mt-3 text-sm text-slate-500'>加载中...</p>}
          {!loading && tasks.length === 0 && <p className='mt-3 text-sm text-slate-500'>当前日期没有任务。</p>}

          <ul className='mt-3 space-y-2'>
            {tasks.map((task) => {
              const isComplete = taskCompletionRatio(task) >= 1;
              return (
              <li key={task.id} className={`rounded-xl border px-3 py-2 ${completionSurfaceClass(isComplete)}`}>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <button type='button' onClick={() => openEditTaskModal(task)} className='min-w-0 flex-1 text-left'>
                    <p className='truncate text-sm font-medium text-slate-900'>
                      {task.title}
                    </p>
                    <p className='truncate text-xs text-slate-500'>
                      {isRangeTask(task)
                        ? `区间 ${taskRangeStart(task)} 至 ${taskRangeEnd(task)}`
                        : task.start_time ? `${task.start_time.slice(0, 5)}-${task.end_time ? task.end_time.slice(0, 5) : '--'}` : '无时间'}
                      {' · '}
                      重要值 {task.importance ?? 50} · 完成度 {Math.round(taskCompletionRatio(task) * 100)}%
                      {task.target_value ? ` · 进度 ${task.progress_value ?? 0}/${task.target_value}` : ''}
                      {task.group_id && groupNameById.get(task.group_id) ? ` · ${groupNameById.get(task.group_id)}` : ''}
                    </p>
                  </button>
                  <div className='flex flex-wrap items-center gap-2'>
                    <label className='flex items-center gap-1 text-xs text-slate-500'>
                      <span>当前值</span>
                      <input
                        type='number'
                        min='0'
                        step='0.01'
                        value={taskProgressDrafts[task.id] ?? (task.progress_value == null ? '' : String(task.progress_value))}
                        onChange={(event) => setTaskProgressDrafts((previous) => ({ ...previous, [task.id]: event.target.value }))}
                        onClick={(event) => event.stopPropagation()}
                        className='w-24 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900'
                      />
                    </label>
                    <button type='button' onClick={() => saveTaskProgress(task)} disabled={loadingActionId === task.id} className='rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm'>
                      保存数值
                    </button>
                    <button type='button' onClick={() => softDeleteTask(task)} disabled={loadingActionId === task.id} className='rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm text-rose-700'>
                      删除
                    </button>
                  </div>
                </div>
              </li>
            );
            })}
          </ul>
        </section>

        {selectedGroup && (
          <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
            <div className='max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl'>
              <div className='flex flex-wrap items-start justify-between gap-3'>
                <div>
                  <h2 className='text-lg font-semibold text-slate-900'>{selectedGroup.name}</h2>
                  <p className='mt-1 text-sm text-slate-500'>
                    {selectedDate} · 完成 {selectedGroupStats.done}/{selectedGroupStats.total} · 完成度 {Math.round(selectedGroupStats.completion * 100)}% · 分数 {selectedGroupStats.score}
                  </p>
                  {selectedGroup.description && <p className='mt-1 text-sm text-slate-600'>{selectedGroup.description}</p>}
                </div>
                <div className='flex flex-wrap gap-2'>
                  <button
                    type='button'
                    onClick={deleteSelectedGroup}
                    disabled={submitLoading}
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

              {(groupChildren.get(selectedGroup.id) ?? []).length > 0 && (
                <div className='mt-5'>
                  <h3 className='text-sm font-semibold text-slate-900'>子组</h3>
                  <div className='mt-2 grid gap-2 sm:grid-cols-2'>
                    {(groupChildren.get(selectedGroup.id) ?? []).map((child) => {
                      const item = groupStats.get(child.id) ?? { total: 0, done: 0, completion: 0, score: 0 };
                      const isComplete = item.total > 0 && item.completion >= 1;
                      return (
                        <button
                          key={child.id}
                          type='button'
                          onClick={() => setSelectedGroupId(child.id)}
                          className={`rounded-xl border p-3 text-left transition hover:border-slate-300 ${completionSurfaceClass(isComplete)}`}
                        >
                          <p className='font-medium text-slate-900'>{child.name}</p>
                          <p className='mt-1 text-sm text-slate-500'>完成 {item.done}/{item.total} · 完成度 {Math.round(item.completion * 100)}%</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className='mt-5'>
                <h3 className='text-sm font-semibold text-slate-900'>组内任务</h3>
                <div className='mt-2 space-y-2'>
                  {selectedGroupTasks.length === 0 && (
                    <p className='rounded-xl bg-slate-50 p-3 text-sm text-slate-500'>当前日期没有组内任务。</p>
                  )}
                  {selectedGroupTasks.map((task) => (
                    (() => {
                      const isComplete = taskCompletionRatio(task) >= 1;
                      return (
                    <button
                      key={task.id}
                      type='button'
                      onClick={() => {
                        setSelectedGroupId(null);
                        openEditTaskModal(task);
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition hover:border-slate-300 ${completionSurfaceClass(isComplete)}`}
                    >
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <p className='font-medium text-slate-900'>{task.title}</p>
                        <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>
                          重要值 {task.importance ?? 50} · 完成度 {Math.round(taskCompletionRatio(task) * 100)}%
                        </span>
                      </div>
                      <p className='mt-1 text-sm text-slate-500'>
                        {isRangeTask(task) ? `区间 ${taskRangeStart(task)} 至 ${taskRangeEnd(task)}` : task.task_date}
                        {task.target_value ? ` · 进度 ${task.progress_value ?? 0}/${task.target_value}` : ''}
                      </p>
                    </button>
                      );
                    })()
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {taskModalOpen && (
          <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
            <form onSubmit={handleSaveTask} className='max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl'>
              <div className='mb-4 flex items-center justify-between gap-3'>
                <h2 className='text-lg font-semibold'>{editingTask ? '修改任务' : '新增任务'}</h2>
                <button type='button' onClick={() => { setTaskModalOpen(false); resetTaskForm(); }} className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'>关闭</button>
              </div>
              <div className={`mb-4 rounded-2xl border px-4 py-3 ${formCompletionRatio >= 1 ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='text-sm font-medium'>当前状态：{formStatusText}</span>
                  <span className='rounded-full bg-white/80 px-3 py-1 text-xs font-semibold'>完成度 {Math.round(formCompletionRatio * 100)}%</span>
                </div>
                <p className='mt-1 text-xs opacity-80'>
                  保存后会按进度和目标自动参与完成度计算。
                </p>
              </div>
              <div className='grid gap-3 md:grid-cols-2'>
                <label className='block md:col-span-2'>
                  <span className='mb-1 block text-sm text-slate-600'>标题</span>
                  <input type='text' value={form.title} onChange={(event) => setForm((previous) => ({ ...previous, title: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block md:col-span-2'>
                  <span className='mb-1 block text-sm text-slate-600'>备注</span>
                  <textarea value={form.description} onChange={(event) => setForm((previous) => ({ ...previous, description: event.target.value }))} rows={2} className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>任务类型</span>
                  <select
                    value={form.taskType}
                    onChange={(event) => setForm((previous) => ({
                      ...previous,
                      taskType: event.target.value as TaskType,
                      rangeStartDate: previous.rangeStartDate || previous.taskDate,
                      rangeEndDate: previous.rangeEndDate || previous.taskDate
                    }))}
                    className='w-full rounded-lg border border-slate-200 p-2'
                  >
                    <option value='single'>普通任务</option>
                    <option value='range'>区间任务</option>
                  </select>
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>当前进度</span>
                  <input value={form.progressValue} onChange={(event) => setForm((previous) => ({ ...previous, progressValue: event.target.value }))} type='number' min='0' step='0.01' placeholder='例如 30' className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>目标值</span>
                  <input value={form.targetValue} onChange={(event) => setForm((previous) => ({ ...previous, targetValue: event.target.value }))} type='number' min='0.01' step='0.01' placeholder='例如 100' className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                {form.taskType === 'single' && (
                  <>
                    <label className='block'>
                      <span className='mb-1 block text-sm text-slate-600'>日期</span>
                      <input type='date' value={form.taskDate} onChange={(event) => setForm((previous) => ({ ...previous, taskDate: clampDateInput(event.target.value) }))} className='w-full rounded-lg border border-slate-200 p-2' />
                    </label>
                    <label className='block'>
                      <span className='mb-1 block text-sm text-slate-600'>开始时间</span>
                      <input type='time' value={form.startTime} onChange={(event) => setForm((previous) => ({ ...previous, startTime: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2' />
                    </label>
                    <label className='block'>
                      <span className='mb-1 block text-sm text-slate-600'>结束时间</span>
                      <input type='time' value={form.endTime} onChange={(event) => setForm((previous) => ({ ...previous, endTime: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2' />
                    </label>
                  </>
                )}
                {form.taskType === 'range' && (
                  <>
                    <label className='block'>
                      <span className='mb-1 block text-sm text-slate-600'>开始日期</span>
                      <input type='date' value={form.rangeStartDate} onChange={(event) => setForm((previous) => ({ ...previous, rangeStartDate: clampDateInput(event.target.value) }))} className='w-full rounded-lg border border-slate-200 p-2' />
                    </label>
                    <label className='block'>
                      <span className='mb-1 block text-sm text-slate-600'>截止日期</span>
                      <input type='date' value={form.rangeEndDate} onChange={(event) => setForm((previous) => ({ ...previous, rangeEndDate: clampDateInput(event.target.value) }))} className='w-full rounded-lg border border-slate-200 p-2' />
                    </label>
                  </>
                )}
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>重要值</span>
                  <input value={form.importance} onChange={(event) => setForm((previous) => ({ ...previous, importance: event.target.value }))} type='number' min='1' max='100' className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                {groupsAvailable && (
                  <label className='block md:col-span-2'>
                    <span className='mb-1 block text-sm text-slate-600'>任务组</span>
                    <select value={form.groupId} onChange={(event) => setForm((previous) => ({ ...previous, groupId: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2'>
                      {renderGroupOptions()}
                    </select>
                  </label>
                )}
                <div className='flex items-end md:col-span-2'>
                  <button type='submit' disabled={submitLoading} className='w-full rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50'>
                    {submitLoading ? '提交中...' : editingTask ? '保存修改' : '新增任务'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {groupModalOpen && (
          <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
            <form onSubmit={handleCreateGroup} className='w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl'>
              <div className='mb-4 flex items-center justify-between gap-3'>
                <h2 className='text-lg font-semibold'>新建任务组</h2>
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
                <button type='submit' disabled={submitLoading} className='rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50'>创建组</button>
              </div>
            </form>
          </div>
        )}

        {batchModalOpen && (
          <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
            <form onSubmit={handleBatchCreate} className='max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl'>
              <div className='mb-4 flex items-center justify-between gap-3'>
                <h2 className='text-lg font-semibold'>高级任务</h2>
                <button type='button' onClick={() => setBatchModalOpen(false)} className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'>关闭</button>
              </div>

              <div className='grid gap-3 md:grid-cols-2'>
                <label className='block md:col-span-2'>
                  <span className='mb-1 block text-sm text-slate-600'>模板</span>
                  <select value={batchForm.templateId} onChange={(event) => setBatchForm((previous) => ({ ...previous, templateId: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2'>
                    {taskTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}（第 {template.offsets.join(' / ')} 天）
                      </option>
                    ))}
                  </select>
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>任务名称</span>
                  <input value={batchForm.title} onChange={(event) => setBatchForm((previous) => ({ ...previous, title: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>开始日期</span>
                  <input type='date' value={batchForm.startDate} onChange={(event) => setBatchForm((previous) => ({ ...previous, startDate: clampDateInput(event.target.value) }))} className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block md:col-span-2'>
                  <span className='mb-1 block text-sm text-slate-600'>备注</span>
                  <textarea value={batchForm.description} onChange={(event) => setBatchForm((previous) => ({ ...previous, description: event.target.value }))} rows={2} className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>重要值</span>
                  <input type='number' min='1' max='100' value={batchForm.importance} onChange={(event) => setBatchForm((previous) => ({ ...previous, importance: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                <label className='block'>
                  <span className='mb-1 block text-sm text-slate-600'>新任务组名</span>
                  <input value={batchForm.groupName} onChange={(event) => setBatchForm((previous) => ({ ...previous, groupName: event.target.value }))} placeholder='留空则自动生成' className='w-full rounded-lg border border-slate-200 p-2' />
                </label>
                {groupsAvailable && (
                  <label className='block'>
                    <span className='mb-1 block text-sm text-slate-600'>放入父组</span>
                    <select value={batchForm.parentGroupId} onChange={(event) => setBatchForm((previous) => ({ ...previous, parentGroupId: event.target.value }))} className='w-full rounded-lg border border-slate-200 p-2'>
                      {renderGroupOptions('无父组')}
                    </select>
                  </label>
                )}
              </div>

              <div className='mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-4'>
                <h3 className='text-sm font-semibold text-slate-900'>自定义模板</h3>
                <div className='mt-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]'>
                  <input value={customTemplateName} onChange={(event) => setCustomTemplateName(event.target.value)} placeholder='模板名称' className='rounded-lg border border-slate-200 p-2' />
                  <input value={customTemplateOffsets} onChange={(event) => setCustomTemplateOffsets(event.target.value)} placeholder='天数，如 0,1,3,7' className='rounded-lg border border-slate-200 p-2' />
                  <button type='button' onClick={handleCreateTemplate} className='rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm'>添加模板</button>
                </div>
                {customTemplates.length > 0 && (
                  <div className='mt-3 flex flex-wrap gap-2'>
                    {customTemplates.map((template) => (
                      <button key={template.id} type='button' onClick={() => deleteCustomTemplate(template.id)} className='rounded-full bg-white px-3 py-1.5 text-xs text-slate-600'>
                        删除 {template.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button type='submit' disabled={submitLoading} className='mt-5 w-full rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50'>
                {submitLoading ? '创建中...' : '按模板创建任务'}
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
