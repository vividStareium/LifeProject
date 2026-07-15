'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import { getBeijingDateInput } from '@/lib/date';
import { periodKey, periodLabel, type PeriodSize } from '@/lib/analytics';
import { completionHeatmapStyle } from '@/lib/heatmap-color';
import { habitDailyRecordSelectFields, habitTemplateSelectFields } from '@/lib/habit-db';
import {
  buildHabitScoreSeries,
  formatHabitValue,
  targetTypeLabel
} from '@/lib/habit-domain';
import { normalizeHabitRecordRow, normalizeHabitTemplateRow } from '@/lib/normalize-db-rows';
import { supabase } from '@/lib/supabase/client';
import type { HabitDailyRecordRow, HabitTemplateRow } from '@/types/habit';

type HabitDetailClientProps = {
  habitId: string;
};
const periodOptions: PeriodSize[] = ['day', 'week', 'month', 'quarter', 'half_year', 'year'];

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

type ValueBarChartProps = {
  values: Array<{ date: string; value: number }>;
  unit?: string | null;
};

function ValueBarChart({ values, unit }: ValueBarChartProps) {
  const maxValue = Math.max(1, ...values.map((item) => Math.max(0, item.value)));
  const latest = values.at(-1);

  return (
    <div>
      <div className='mb-3 flex items-center justify-between gap-3 text-sm'>
        <p className='font-medium text-slate-900'>实际值统计</p>
        {latest && (
          <p className='text-slate-500'>
            {latest.date}：{formatHabitValue(latest.value)}
            {unit ? ` ${unit}` : ''}
          </p>
        )}
      </div>
      <div className='overflow-x-auto rounded-2xl border border-slate-100 bg-slate-50 p-3'>
        <div className='flex h-56 min-w-[720px] gap-1'>
          {values.map((item) => {
            const normalizedValue = Math.max(0, item.value);
            const height = normalizedValue === 0 ? 0 : Math.max(2, (normalizedValue / maxValue) * 100);
            return (
              <div key={item.date} className='flex min-w-12 flex-1 flex-col items-center gap-2'>
                <div className='flex h-48 w-full items-end pt-4'>
                  <div
                    title={`${item.date}：${formatHabitValue(item.value)}${unit ? ` ${unit}` : ''}`}
                    className='relative w-full rounded-t bg-sky-500 transition hover:bg-sky-600'
                    style={{ height: `${height}%` }}
                  >
                    <span className='pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium leading-none text-slate-600'>
                      {formatHabitValue(item.value)}
                    </span>
                  </div>
                </div>
                <span className='max-w-14 truncate text-[10px] text-slate-500'>{item.date}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function HabitDetailClient({ habitId }: HabitDetailClientProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [template, setTemplate] = useState<HabitTemplateRow | null>(null);
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

    const templateResult = await supabase
      .from('habit_templates')
      .select(habitTemplateSelectFields)
      .eq('user_id', currentUser.id)
      .eq('id', habitId)
      .single();

    if (templateResult.error) {
      setError('未找到这个习惯，或当前账号没有访问权限。');
      setLoading(false);
      return;
    }

    const loadedTemplate = normalizeHabitTemplateRow(templateResult.data as unknown as Record<string, unknown>);
    const recordResult = await supabase
      .from('habit_daily_records')
      .select(habitDailyRecordSelectFields)
      .eq('user_id', currentUser.id)
      .eq('template_id', habitId)
      .gte('record_date', loadedTemplate.start_date)
      .order('record_date', { ascending: false });

    if (recordResult.error) {
      setError('读取习惯记录失败。');
      setLoading(false);
      return;
    }

    setTemplate(loadedTemplate);
    setRecords((recordResult.data ?? []).map((row) => normalizeHabitRecordRow(row as unknown as Record<string, unknown>)));
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [habitId]);

  const timeline = useMemo(() => {
    if (!template) {
      return [];
    }

    return buildHabitScoreSeries(template, records, template.start_date, getBeijingDateInput());
  }, [records, template]);

  const stats = useMemo(() => {
    const dueTimeline = timeline.filter((item) => item.isDue);
    const doneDays = dueTimeline.filter((item) => item.evaluation.isDone).length;
    const ratioAvg = dueTimeline.length
      ? dueTimeline.reduce((sum, item) => sum + item.evaluation.completionRatio, 0) / dueTimeline.length
      : 0;
    let longestStreak = 0;
    let runningStreak = 0;

    for (const item of timeline) {
      if (!item.isDue) {
        continue;
      }

      if (item.evaluation.isDone) {
        runningStreak += 1;
        longestStreak = Math.max(longestStreak, runningStreak);
      } else {
        runningStreak = 0;
      }
    }

    let currentStreak = 0;
    for (const item of [...timeline].reverse()) {
      if (!item.isDue) {
        continue;
      }

      if (!item.evaluation.isDone) {
        break;
      }

      currentStreak += 1;
    }

    return {
      doneDays,
      dueDays: dueTimeline.length,
      ratioAvg: Math.round(ratioAvg * 1000) / 1000,
      longestStreak,
      currentStreak
    };
  }, [timeline]);

  const periodTimeline = useMemo(() => {
    const map = new Map<string, typeof timeline>();

    for (const item of timeline) {
      const key = periodKey(item.date, period);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }

    return Array.from(map.entries()).map(([key, list]) => {
      const sorted = [...list].sort((left, right) => left.date.localeCompare(right.date));
      const dueItems = sorted.filter((item) => item.isDue);
      return {
        key,
        label: key,
        completionRatio: dueItems.length
          ? dueItems.reduce((sum, item) => sum + item.evaluation.completionRatio, 0) / dueItems.length
          : 0,
        actualValue: period === 'day'
          ? sorted.at(-1)?.evaluation.actualValue ?? 0
          : sorted.reduce((sum, item) => sum + item.evaluation.actualValue, 0),
        score: sorted.at(-1)?.score ?? 0,
        dueCount: dueItems.length,
        doneCount: dueItems.filter((item) => item.evaluation.isDone).length
      };
    }).sort((left, right) => left.key.localeCompare(right.key));
  }, [period, timeline]);
  const heatmapTimeline = useMemo(
    () => [...periodTimeline].reverse(),
    [periodTimeline]
  );

  const toggleArchive = async () => {
    if (!user || !template) {
      return;
    }

    const nextArchivedAt = template.archived_at ? null : new Date().toISOString();
    const { error: archiveError } = await supabase
      .from('habit_templates')
      .update({ archived_at: nextArchivedAt })
      .eq('id', template.id)
      .eq('user_id', user.id);

    if (archiveError) {
      setError('更新归档状态失败。');
      return;
    }

    setMessage(nextArchivedAt ? '已归档习惯' : '已恢复习惯');
    await loadData();
  };

  const toggleTerminate = async () => {
    if (!user || !template) {
      return;
    }

    const today = getBeijingDateInput();
    const nextEndDate = template.end_date ? null : today < template.start_date ? template.start_date : today;
    const { error: terminateError } = await supabase
      .from('habit_templates')
      .update({ end_date: nextEndDate })
      .eq('id', template.id)
      .eq('user_id', user.id);

    if (terminateError) {
      setError('更新终止日期失败。');
      return;
    }

    setMessage(nextEndDate ? '已终止习惯，历史记录会继续保留' : '已恢复为长期习惯');
    await loadData();
  };

  const deleteHabit = async () => {
    if (!user || !template) {
      return;
    }

    const confirmed = window.confirm(`确定删除习惯“${template.title}”吗？相关每日记录也会一起删除。`);
    if (!confirmed) {
      return;
    }

    const { error: recordError } = await supabase
      .from('habit_daily_records')
      .delete()
      .eq('user_id', user.id)
      .eq('template_id', template.id);

    if (recordError) {
      setError('删除每日记录失败。');
      return;
    }

    const { error: templateError } = await supabase
      .from('habit_templates')
      .delete()
      .eq('user_id', user.id)
      .eq('id', template.id);

    if (templateError) {
      setError('删除习惯失败。');
      return;
    }

    router.replace('/habits');
  };

  return (
    <AppShell
      title={template?.title ?? '习惯详情'}
      description='查看单个习惯的热力图、完成度趋势和分数趋势。'
      activeHref='/habits'
      actions={
        <div className='flex flex-wrap gap-2'>
          <Link href='/habits' className='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700'>
            返回习惯
          </Link>
          <Link href='/habits' className='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700'>
            编辑
          </Link>
          <button type='button' onClick={toggleArchive} className='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700'>
            {template?.archived_at ? '恢复' : '归档'}
          </button>
          <button type='button' onClick={toggleTerminate} className='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700'>
            {template?.end_date ? '恢复终止' : '终止'}
          </button>
          <button type='button' onClick={deleteHabit} className='rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700'>
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

      {template && (
        <>
          <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-5'>
            <StatCard label='完成天数' value={stats.doneDays} hint={`应完成 ${stats.dueDays} 天`} />
            <StatCard label='平均完成度' value={stats.ratioAvg} />
            <StatCard label='当前连续完成' value={stats.currentStreak} hint='按应完成日统计' />
            <StatCard label='最长连续完成' value={stats.longestStreak} hint='按应完成日统计' />
            <StatCard label='目标' value={template.target_value ?? '无'} hint={targetTypeLabel(template.target_type)} />
          </div>

          <Panel title='基础信息'>
            <div className='grid gap-3 text-sm text-slate-600 md:grid-cols-2'>
              <p>问题：{template.question ?? '未填写'}</p>
              <p>单位：{template.unit ?? '未填写'}</p>
              <p>目标类型：{targetTypeLabel(template.target_type)}</p>
              <p>起始日期：{template.start_date}</p>
              <p>终止日期：{template.end_date ?? '长期有效'}</p>
              <p>状态：{template.archived_at ? '已归档' : template.end_date && getBeijingDateInput() > template.end_date ? '已终止' : '活跃'}</p>
              <p className='md:col-span-2'>说明：{template.description ?? '未填写'}</p>
            </div>
          </Panel>

          <Panel title='统计粒度' description='控制该习惯热力图和分数折线中每个点代表的时间区间。'>
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

          <Panel title='习惯热力图' description='颜色越深表示当天完成度越高；无记录日期按 0 计算。'>
            <div className='overflow-x-auto'>
              <div className={`${period === 'day' ? 'grid min-w-[720px] grid-flow-col grid-rows-7 gap-1' : 'grid min-w-[320px] grid-cols-2 gap-2 sm:grid-cols-4'}`}>
                {heatmapTimeline.map((item) => {
                  const ratio = item.completionRatio;
                  return (
                    <div
                      key={item.key}
                      title={`${item.label} 完成度 ${ratio}`}
                      style={completionHeatmapStyle(ratio * 100)}
                      className={period === 'day' ? 'h-4 w-4 rounded-[4px]' : 'rounded-2xl p-3 text-sm'}
                    >
                      {period !== 'day' && (
                        <>
                          <span className='block font-semibold'>{item.label}</span>
                          <span className='text-xs'>
                            完成度 {Math.round(ratio * 100)}% · {item.doneCount}/{item.dueCount}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </Panel>

          <div className='grid gap-4 xl:grid-cols-2'>
            <Panel title='实际值柱状图' description={period === 'day' ? '每根柱代表当天记录的实际值。' : '每根柱代表该时间区间内实际值合计。'}>
              <ValueBarChart
                values={periodTimeline.map((item) => ({
                  date: item.label,
                  value: item.actualValue
                }))}
                unit={template.unit}
              />
            </Panel>

            <Panel title='完成度趋势'>
              <TrendLine
                title='完成度'
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

        </>
      )}
    </AppShell>
  );
}
