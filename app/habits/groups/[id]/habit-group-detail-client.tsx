'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import { periodKey, periodLabel, type PeriodSize } from '@/lib/analytics';
import { getBeijingDateInput, shiftDateInput } from '@/lib/date';
import { completionHeatmapStyle } from '@/lib/heatmap-color';
import { habitDailyRecordSelectFields, habitTemplateSelectFields } from '@/lib/habit-db';
import {
  buildHabitScoreSeries,
  evaluateHabitRecord,
  formatHabitValue,
  habitImportance,
  isHabitDueOnDate
} from '@/lib/habit-domain';
import { normalizeHabitRecordRow, normalizeHabitTemplateRow } from '@/lib/normalize-db-rows';
import { supabase } from '@/lib/supabase/client';
import type { HabitDailyRecordRow, HabitGroupRow, HabitTemplateRow } from '@/types/habit';

type HabitGroupDetailClientProps = {
  groupId: string;
};

type GroupPoint = {
  date: string;
  completionRatio: number;
  score: number;
  dueCount: number;
  doneCount: number;
};

const periodOptions: PeriodSize[] = ['day', 'week', 'month', 'quarter', 'half_year', 'year'];

const recentRange = () => {
  const endInput = getBeijingDateInput();
  const startInput = shiftDateInput(endInput, -180);
  return { startInput, endInput };
};

type TrendLineProps = {
  title: string;
  values: Array<{ date: string; value: number }>;
  maxValue: number;
  strokeClassName: string;
  suffix?: string;
};

function TrendLine({ title, values, maxValue, strokeClassName, suffix = '' }: TrendLineProps) {
  const points = values.map((item, index) => {
    const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 95 - (Math.min(maxValue, Math.max(0, item.value)) / maxValue) * 90;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const latest = values.at(-1);

  return (
    <div>
      <div className='mb-3 flex items-center justify-between gap-3 text-sm'>
        <p className='font-medium text-slate-900'>{title}</p>
        {latest && (
          <p className='text-slate-500'>
            {latest.date}：{formatHabitValue(latest.value)}
            {suffix}
          </p>
        )}
      </div>
      <div className='h-44 rounded-2xl border border-slate-100 bg-slate-50 p-3'>
        <svg viewBox='0 0 100 100' preserveAspectRatio='none' className='h-full w-full'>
          <line x1='0' y1='95' x2='100' y2='95' className='stroke-slate-200' strokeWidth='1' />
          <line x1='0' y1='50' x2='100' y2='50' className='stroke-slate-200' strokeWidth='0.6' strokeDasharray='2 2' />
          <polyline
            points={points.join(' ')}
            fill='none'
            className={strokeClassName}
            strokeWidth='2.5'
            vectorEffect='non-scaling-stroke'
          />
        </svg>
      </div>
    </div>
  );
}

export default function HabitGroupDetailClient({ groupId }: HabitGroupDetailClientProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [group, setGroup] = useState<HabitGroupRow | null>(null);
  const [groups, setGroups] = useState<HabitGroupRow[]>([]);
  const [templates, setTemplates] = useState<HabitTemplateRow[]>([]);
  const [records, setRecords] = useState<HabitDailyRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [period, setPeriod] = useState<PeriodSize>('day');

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
    const { startInput } = recentRange();

    const [groupResult, groupsResult, templateResult, recordResult] = await Promise.all([
      supabase
        .from('habit_groups')
        .select('id,user_id,parent_id,name,description,color,created_at,updated_at')
        .eq('user_id', currentUser.id)
        .eq('id', groupId)
        .single(),
      supabase
        .from('habit_groups')
        .select('id,user_id,parent_id,name,description,color,created_at,updated_at')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('habit_templates')
        .select(habitTemplateSelectFields)
        .eq('user_id', currentUser.id)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('habit_daily_records')
        .select(habitDailyRecordSelectFields)
        .eq('user_id', currentUser.id)
        .gte('record_date', startInput)
        .order('record_date', { ascending: false })
    ]);

    if (groupResult.error) {
      setError('未找到这个习惯组，或当前账号没有访问权限。');
      setLoading(false);
      return;
    }

    if (groupsResult.error || templateResult.error || recordResult.error) {
      setError('读取习惯组详情失败。');
      setLoading(false);
      return;
    }

    setGroup(groupResult.data as unknown as HabitGroupRow);
    setGroups((groupsResult.data ?? []) as unknown as HabitGroupRow[]);
    setTemplates((templateResult.data ?? []).map((row) => normalizeHabitTemplateRow(row as unknown as Record<string, unknown>)));
    setRecords((recordResult.data ?? []).map((row) => normalizeHabitRecordRow(row as unknown as Record<string, unknown>)));
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [groupId]);

  const childGroups = useMemo(
    () => groups.filter((item) => item.parent_id === groupId),
    [groupId, groups]
  );

  const groupIds = useMemo(() => {
    const children = new Map<string, HabitGroupRow[]>();
    for (const item of groups) {
      const list = children.get(item.parent_id ?? 'root') ?? [];
      list.push(item);
      children.set(item.parent_id ?? 'root', list);
    }

    const ids = new Set<string>();
    const visit = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of children.get(id) ?? []) {
        visit(child.id);
      }
    };

    visit(groupId);
    return ids;
  }, [groupId, groups]);

  const groupTemplates = useMemo(
    () => templates.filter((template) => !template.archived_at && template.group_id && groupIds.has(template.group_id)),
    [groupIds, templates]
  );

  const timeline = useMemo<GroupPoint[]>(() => {
    if (!groupTemplates.length) {
      return [];
    }

    const { startInput, endInput } = recentRange();
    const days = Array.from({ length: 181 }, (_, index) => shiftDateInput(startInput, index));
    const recordByTemplateAndDate = new Map(
      records.map((record) => [`${record.template_id}:${record.record_date}`, record])
    );
    const scoreByTemplateAndDate = new Map<string, number>();

    for (const template of groupTemplates) {
      const templateRecords = records.filter((record) => record.template_id === template.id);
      for (const point of buildHabitScoreSeries(template, templateRecords, startInput, endInput)) {
        scoreByTemplateAndDate.set(`${template.id}:${point.date}`, point.score);
      }
    }

    return days.map((date) => {
      const dueTemplates = groupTemplates.filter((template) => isHabitDueOnDate(template, date));
      const completionItems = dueTemplates.map((template) => {
        const record = recordByTemplateAndDate.get(`${template.id}:${date}`);
        return {
          ratio: evaluateHabitRecord(template, record, date).completionRatio,
          isDone: evaluateHabitRecord(template, record, date).isDone,
          weight: habitImportance(template)
        };
      });
      const completionWeight = completionItems.reduce((sum, item) => sum + item.weight, 0);
      const completionRatio = completionWeight > 0
        ? completionItems.reduce((sum, item) => sum + item.ratio * item.weight, 0) / completionWeight
        : 0;
      const scoreItems = groupTemplates.map((template) => ({
        score: scoreByTemplateAndDate.get(`${template.id}:${date}`) ?? 0,
        weight: habitImportance(template)
      }));
      const scoreWeight = scoreItems.reduce((sum, item) => sum + item.weight, 0);
      const score = scoreWeight > 0
        ? scoreItems.reduce((sum, item) => sum + item.score * item.weight, 0) / scoreWeight
        : 0;

      return {
        date,
        completionRatio,
        score: Math.round(score),
        dueCount: dueTemplates.length,
        doneCount: completionItems.filter((item) => item.isDone).length
      };
    });
  }, [groupTemplates, records]);

  const stats = useMemo(() => {
    const latest = timeline.at(-1);
    const activeDays = timeline.filter((item) => item.dueCount > 0);
    const averageCompletion = activeDays.length
      ? activeDays.reduce((sum, item) => sum + item.completionRatio, 0) / activeDays.length
      : 0;

    return {
      templateCount: groupTemplates.length,
      childGroupCount: childGroups.length,
      latestCompletion: latest ? Math.round(latest.completionRatio * 100) : 0,
      latestScore: latest?.score ?? 0,
      averageCompletion: Math.round(averageCompletion * 100)
    };
  }, [childGroups.length, groupTemplates.length, timeline]);

  const periodTimeline = useMemo(() => {
    const map = new Map<string, GroupPoint[]>();

    for (const item of timeline) {
      const key = periodKey(item.date, period);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }

    return Array.from(map.entries()).map(([key, list]) => {
      const sorted = [...list].sort((left, right) => left.date.localeCompare(right.date));
      return {
        key,
        label: key,
        completionRatio:
          sorted.reduce((sum, item) => sum + item.completionRatio, 0) / sorted.length,
        score: sorted.at(-1)?.score ?? 0
      };
    }).sort((left, right) => left.key.localeCompare(right.key));
  }, [period, timeline]);

  const heatmapTimeline = useMemo(
    () => [...periodTimeline].reverse(),
    [periodTimeline]
  );

  const deleteGroup = async () => {
    if (!user || !group) {
      return;
    }

    if (!window.confirm(`确定删除习惯组“${group.name}”吗？组内习惯不会被删除，只会移出该组。`)) {
      return;
    }

    const { error: templateUpdateError } = await supabase
      .from('habit_templates')
      .update({ group_id: null })
      .eq('user_id', user.id)
      .in('group_id', Array.from(groupIds));

    if (templateUpdateError) {
      setError('移出组内习惯失败。');
      return;
    }

    const { error: childUpdateError } = await supabase
      .from('habit_groups')
      .update({ parent_id: null })
      .eq('user_id', user.id)
      .eq('parent_id', group.id);

    if (childUpdateError) {
      setError('处理子组失败。');
      return;
    }

    const { error: groupDeleteError } = await supabase
      .from('habit_groups')
      .delete()
      .eq('id', group.id)
      .eq('user_id', user.id);

    if (groupDeleteError) {
      setError('删除习惯组失败。');
      return;
    }

    router.replace('/habits');
  };

  return (
    <AppShell
      title={group?.name ?? '习惯组详情'}
      description='查看习惯组的完成度热力图、长期分数趋势、子组和组内习惯。'
      activeHref='/habits'
      actions={
        <div className='flex flex-wrap gap-2'>
          <Link href='/habits' className='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700'>
            返回习惯
          </Link>
          <button type='button' onClick={deleteGroup} className='rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700'>
            删除
          </button>
        </div>
      }
      onSignOut={async () => {
        await supabase.auth.signOut();
        router.replace('/auth/login');
      }}
    >
      {loading && <p className='rounded-2xl bg-white p-4 text-sm text-slate-500'>加载中...</p>}
      {error && <p className='rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700'>{error}</p>}
      {message && <p className='rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700'>{message}</p>}

      {group && (
        <>
          <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-5'>
            <StatCard label='组内习惯' value={stats.templateCount} hint='包含子组内习惯' />
            <StatCard label='子组' value={stats.childGroupCount} />
            <StatCard label='今日完成度' value={`${stats.latestCompletion}%`} />
            <StatCard label='当前分数' value={stats.latestScore} />
            <StatCard label='平均完成度' value={`${stats.averageCompletion}%`} hint='最近 181 天有应完成项的日期' />
          </div>

          <Panel title='基础信息'>
            <div className='grid gap-3 text-sm text-slate-600 md:grid-cols-2'>
              <p>组名：{group.name}</p>
              <p>创建时间：{group.created_at.slice(0, 10)}</p>
              <p className='md:col-span-2'>说明：{group.description ?? '未填写'}</p>
            </div>
          </Panel>

          <Panel title='统计粒度' description='控制该习惯组热力图和分数折线中每个点代表的时间区间。'>
            <div className='flex flex-wrap gap-2'>
              {periodOptions.map((option) => (
                <button
                  key={option}
                  type='button'
                  onClick={() => setPeriod(option)}
                  className={`rounded-xl px-3 py-2 text-sm font-medium ${period === option ? 'bg-slate-900 text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
                >
                  {periodLabel(option)}
                </button>
              ))}
            </div>
          </Panel>

          <Panel title='习惯组热力图' description='颜色表示该组当天加权完成度；无记录日期按 0 计算。'>
            <div className='overflow-x-auto'>
              <div className={`${period === 'day' ? 'grid min-w-[720px] grid-flow-col grid-rows-7 gap-1' : 'grid min-w-[320px] grid-cols-2 gap-2 sm:grid-cols-4'}`}>
                {heatmapTimeline.map((item) => {
                  const ratio = item.completionRatio;
                  return (
                    <div
                      key={item.key}
                      title={`${item.label} 完成度 ${Math.round(ratio * 100)}%`}
                      style={completionHeatmapStyle(ratio * 100)}
                      className={period === 'day' ? 'h-4 w-4 rounded-[4px]' : 'rounded-2xl p-3 text-sm'}
                    >
                      {period !== 'day' && (
                        <>
                          <span className='block font-semibold'>{item.label}</span>
                          <span className='text-xs'>完成度 {Math.round(ratio * 100)}%</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </Panel>

          <div className='grid gap-4 xl:grid-cols-2'>
            <Panel title='完成度趋势'>
              <TrendLine
                title='最近 181 天完成度'
                values={periodTimeline.map((item) => ({
                  date: item.label,
                  value: item.completionRatio
                }))}
                maxValue={1}
                strokeClassName='stroke-sky-500'
              />
            </Panel>

            <Panel title='分数趋势'>
              <TrendLine
                title='长期动态分数'
                values={periodTimeline.map((item) => ({
                  date: item.label,
                  value: item.score
                }))}
                maxValue={100}
                strokeClassName='stroke-indigo-500'
              />
            </Panel>
          </div>

          <div className='grid gap-4 xl:grid-cols-2'>
            <Panel title='子组'>
              <div className='space-y-2'>
                {childGroups.length === 0 && <p className='text-sm text-slate-500'>这个组没有子组。</p>}
                {childGroups.map((child) => (
                  <Link key={child.id} href={`/habits/groups/${child.id}`} className='block rounded-xl border border-slate-100 bg-slate-50 p-3 transition hover:border-slate-300'>
                    <p className='font-medium text-slate-900'>{child.name}</p>
                    {child.description && <p className='mt-1 text-sm text-slate-500'>{child.description}</p>}
                  </Link>
                ))}
              </div>
            </Panel>

            <Panel title='组内习惯'>
              <div className='space-y-2'>
                {groupTemplates.length === 0 && <p className='text-sm text-slate-500'>这个组还没有习惯。</p>}
                {groupTemplates.map((template) => {
                  const latestRecord = records.find((record) => record.template_id === template.id && record.record_date === getBeijingDateInput());
                  const evaluation = evaluateHabitRecord(template, latestRecord, getBeijingDateInput());
                  return (
                    <Link key={template.id} href={`/habits/${template.id}`} className='block rounded-xl border border-slate-100 bg-slate-50 p-3 transition hover:border-slate-300'>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <p className='font-medium text-slate-900'>{template.title}</p>
                        <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>重要值 {habitImportance(template)}</span>
                      </div>
                      <p className='mt-1 text-sm text-slate-500'>
                        今日值 {formatHabitValue(evaluation.actualValue)} · 完成度 {Math.round(evaluation.completionRatio * 100)}%
                      </p>
                    </Link>
                  );
                })}
              </div>
            </Panel>
          </div>
        </>
      )}
    </AppShell>
  );
}
