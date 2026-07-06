'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import { getBeijingDateInput, parseDateInput, shiftDateInput } from '@/lib/date';
import { periodLabel, type PeriodSize } from '@/lib/analytics';
import { completionHeatmapStyle } from '@/lib/heatmap-color';
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

const detailPeriodKey = (date: string, period: PeriodSize) => {
  const parsed = parseDateInput(date);
  if (!parsed) return date;
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;
  if (period === 'day') return date;
  if (period === 'week') {
    const weekStart = new Date(parsed);
    const day = weekStart.getUTCDay();
    weekStart.setUTCDate(weekStart.getUTCDate() - (day === 0 ? 6 : day - 1));
    return weekStart.toISOString().slice(0, 10);
  }
  if (period === 'month') return `${year}-${String(month).padStart(2, '0')}`;
  if (period === 'quarter') return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === 'half_year') return `${year}-H${month <= 6 ? 1 : 2}`;
  return String(year);
};

const recentRange = () => {
  const end = parseDateInput(getBeijingDateInput()) ?? new Date();
  const startInput = shiftDateInput(getBeijingDateInput(), -180);
  const start = parseDateInput(startInput) ?? end;
  return { start, end, startInput };
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
    const { startInput } = recentRange();

    const [templateResult, recordResult] = await Promise.all([
      supabase
        .from('habit_templates')
        .select(
          'id,user_id,source_key,source_name,source_type,title,description,question,frequency_kind,frequency_rule,unit,target_type,target_value,color,sort_order,archived_at,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .eq('id', habitId)
        .single(),
      supabase
        .from('habit_daily_records')
        .select(
          'id,user_id,template_id,record_date,value_text,value_number,completion_state,notes,source_type,source_key,raw_payload,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .eq('template_id', habitId)
        .gte('record_date', startInput)
        .order('record_date', { ascending: false })
    ]);

    if (templateResult.error) {
      setError('未找到这个习惯，或当前账号没有访问权限。');
      setLoading(false);
      return;
    }

    if (recordResult.error) {
      setError('读取习惯记录失败。');
      setLoading(false);
      return;
    }

    setTemplate(normalizeHabitTemplateRow(templateResult.data as Record<string, unknown>));
    setRecords((recordResult.data ?? []).map((row) => normalizeHabitRecordRow(row as Record<string, unknown>)));
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [habitId]);

  const timeline = useMemo(() => {
    if (!template) {
      return [];
    }

    const { startInput } = recentRange();
    return buildHabitScoreSeries(template, records, startInput, getBeijingDateInput());
  }, [records, template]);

  const stats = useMemo(() => {
    const doneDays = timeline.filter((item) => item.evaluation.isDone).length;
    const ratioAvg = timeline.length
      ? timeline.reduce((sum, item) => sum + item.evaluation.completionRatio, 0) / timeline.length
      : 0;

    return {
      doneDays,
      ratioAvg: Math.round(ratioAvg * 1000) / 1000
    };
  }, [timeline]);
  const periodTimeline = useMemo(() => {
    const map = new Map<string, typeof timeline>();

    for (const item of timeline) {
      const key = detailPeriodKey(item.date, period);
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
          sorted.reduce((sum, item) => sum + item.evaluation.completionRatio, 0) / sorted.length,
        score: sorted.at(-1)?.score ?? 0
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
          <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
            <StatCard label='完成天数' value={stats.doneDays} hint='最近 181 天' />
            <StatCard label='平均完成度' value={stats.ratioAvg} />
            <StatCard label='目标' value={template.target_value ?? '无'} hint={targetTypeLabel(template.target_type)} />
          </div>

          <Panel title='基础信息'>
            <div className='grid gap-3 text-sm text-slate-600 md:grid-cols-2'>
              <p>问题：{template.question ?? '未填写'}</p>
              <p>单位：{template.unit ?? '未填写'}</p>
              <p>目标类型：{targetTypeLabel(template.target_type)}</p>
              <p>状态：{template.archived_at ? '已归档' : '活跃'}</p>
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

        </>
      )}
    </AppShell>
  );
}
