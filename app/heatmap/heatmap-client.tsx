'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import {
  buildDailySummaries,
  buildHeatmapWeeks,
  buildPeriodPoints,
  isRangeTask,
  periodLabel,
  taskCompletionRatio,
  taskRangeEnd,
  taskRangeStart,
  type HeatmapMetric,
  type PeriodPoint,
  type PeriodSize
} from '@/lib/analytics';
import { addMonths, getBeijingDateInput, parseDateInput, toDateInputValue } from '@/lib/date';
import { completionHeatmapStyle } from '@/lib/heatmap-color';
import { formatHabitValue } from '@/lib/habit-domain';
import { normalizeHabitRecordRow, normalizeHabitTemplateRow } from '@/lib/normalize-db-rows';
import { supabase } from '@/lib/supabase/client';
import type { HabitDailyRecordRow, HabitTaskLike, HabitTemplateRow } from '@/types/habit';

const metricOptions: Array<{ value: HeatmapMetric; label: string; description: string }> = [
  { value: 'activity', label: '加权完成度', description: '任务和习惯按重要值加权' },
  { value: 'task_done', label: '任务完成率', description: '当天已完成任务占比' },
  { value: 'record_count', label: '习惯平均完成度', description: '当天习惯完成度平均值' },
  { value: 'habit_done', label: '习惯完成率', description: '当天完成习惯占比' }
];

const compactWeekLabels = ['日', '一', '二', '三', '四', '五', '六'];
const priorityLabels = {
  low: '低',
  medium: '中',
  high: '高'
} as const;
const periodOptions: PeriodSize[] = ['day', 'week', 'month', 'quarter', 'half_year', 'year'];
type DetailModalType = 'all' | 'tasks' | 'habits';
type HeatmapRangeMode = 'recent_12_months' | 'year' | 'recent_5_years' | 'recent_10_years';

const rangeModeLabels: Record<HeatmapRangeMode, string> = {
  recent_12_months: '最近 12 个月',
  year: '指定年份',
  recent_5_years: '最近 5 年',
  recent_10_years: '最近 10 年'
};

const rangeModesForPeriod = (period: PeriodSize): HeatmapRangeMode[] => {
  if (period === 'day') {
    return ['recent_12_months', 'year'];
  }

  if (period === 'week' || period === 'month') {
    return ['recent_12_months', 'year', 'recent_5_years'];
  }

  return ['recent_5_years', 'recent_10_years', 'year'];
};

const yearBounds = (year: number, today: string) => {
  const currentYear = Number(today.slice(0, 4));
  const startDate = `${year}-01-01`;
  const endDate = year >= currentYear ? today : `${year}-12-31`;

  return { startDate, endDate };
};

const recentYearBounds = (years: number, today: string) => {
  const currentYear = Number(today.slice(0, 4));

  return {
    startDate: `${currentYear - years + 1}-01-01`,
    endDate: today
  };
};

function ScoreLine({ values }: { values: Array<{ label: string; score: number }> }) {
  const points = values.map((item, index) => {
    const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 95 - (Math.min(100, Math.max(0, item.score)) / 100) * 90;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const latest = values.at(-1);

  return (
    <div>
      <div className='mb-3 flex items-center justify-between gap-3 text-sm'>
        <p className='font-medium text-slate-900'>总榜分数折线</p>
        {latest && <p className='text-slate-500'>{latest.label}：{latest.score}</p>}
      </div>
      <div className='h-44 rounded-2xl border border-slate-100 bg-slate-50 p-3'>
        <svg viewBox='0 0 100 100' preserveAspectRatio='none' className='h-full w-full'>
          <line x1='0' y1='95' x2='100' y2='95' className='stroke-slate-200' strokeWidth='1' />
          <line x1='0' y1='50' x2='100' y2='50' className='stroke-slate-200' strokeWidth='0.6' strokeDasharray='2 2' />
          <polyline points={points.join(' ')} fill='none' className='stroke-indigo-500' strokeWidth='2.5' vectorEffect='non-scaling-stroke' />
        </svg>
      </div>
    </div>
  );
}

export default function HeatmapClient() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [metric, setMetric] = useState<HeatmapMetric>('activity');
  const [period, setPeriod] = useState<PeriodSize>('day');
  const [rangeMode, setRangeMode] = useState<HeatmapRangeMode>('recent_12_months');
  const [selectedYear, setSelectedYear] = useState(() => Number(getBeijingDateInput().slice(0, 4)));
  const [selectedDate, setSelectedDate] = useState(() => getBeijingDateInput());
  const [detailModalType, setDetailModalType] = useState<DetailModalType | null>(null);
  const [selectedPeriodPoint, setSelectedPeriodPoint] = useState<PeriodPoint | null>(null);
  const [templates, setTemplates] = useState<HabitTemplateRow[]>([]);
  const [tasks, setTasks] = useState<HabitTaskLike[]>([]);
  const [records, setRecords] = useState<HabitDailyRecordRow[]>([]);

  const todayInput = getBeijingDateInput();
  const availableRangeModes = useMemo(() => rangeModesForPeriod(period), [period]);
  const availableYears = useMemo(() => {
    const currentYear = Number(todayInput.slice(0, 4));
    return Array.from({ length: 11 }, (_, index) => currentYear - index);
  }, [todayInput]);
  const rangeBounds = useMemo(() => {
    if (rangeMode === 'year') {
      return yearBounds(selectedYear, todayInput);
    }

    if (rangeMode === 'recent_5_years') {
      return recentYearBounds(5, todayInput);
    }

    if (rangeMode === 'recent_10_years') {
      return recentYearBounds(10, todayInput);
    }

    const today = parseDateInput(todayInput) ?? new Date();
    return {
      startDate: toDateInputValue(addMonths(today, -12)),
      endDate: todayInput
    };
  }, [rangeMode, selectedYear, todayInput]);

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

    const startDate = rangeBounds.startDate;
    const endDate = rangeBounds.endDate;

    const taskSelectWithImportance =
      'id,user_id,title,description,task_date,task_type,range_start_date,range_end_date,progress_value,target_value,start_time,end_time,status,priority,importance,category,created_at,updated_at,deleted_at';
    const taskSelectWithRangeWithoutImportance =
      'id,user_id,title,description,task_date,task_type,range_start_date,range_end_date,progress_value,target_value,start_time,end_time,status,priority,category,created_at,updated_at,deleted_at';
    const taskSelectWithoutImportance =
      'id,user_id,title,description,task_date,start_time,end_time,status,priority,category,created_at,updated_at,deleted_at';
    const buildTaskQuery = (selectFields: string, includeRange: boolean) => {
      const query = supabase
        .from('tasks')
        .select(selectFields)
        .eq('user_id', currentUser.id)
        .is('deleted_at', null);

      const filtered = includeRange
        ? query.or(`and(task_date.gte.${startDate},task_date.lte.${endDate}),and(task_type.eq.range,range_start_date.lte.${endDate},range_end_date.gte.${startDate})`)
        : query.gte('task_date', startDate).lte('task_date', endDate);

      return filtered
        .order('task_date', { ascending: false })
        .order('start_time', { ascending: true, nullsFirst: false });
    };

    const taskResultPromise = buildTaskQuery(taskSelectWithImportance, true);

    const [templateResult, firstTaskResult, recordResult] = await Promise.all([
      supabase
        .from('habit_templates')
        .select(
          'id,user_id,source_key,source_name,source_type,title,description,question,frequency_kind,frequency_rule,unit,target_type,target_value,color,sort_order,archived_at,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .order('sort_order', { ascending: true }),
      taskResultPromise,
      supabase
        .from('habit_daily_records')
        .select(
          'id,user_id,template_id,record_date,value_text,value_number,completion_state,notes,source_type,source_key,raw_payload,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .gte('record_date', startDate)
        .lte('record_date', endDate)
        .order('record_date', { ascending: false })
        .order('created_at', { ascending: false })
    ]);
    let taskResult = firstTaskResult;
    if (firstTaskResult.error) {
      const rangeWithoutImportanceResult = await buildTaskQuery(taskSelectWithRangeWithoutImportance, true);
      taskResult = rangeWithoutImportanceResult.error
        ? await buildTaskQuery(taskSelectWithoutImportance, false)
        : rangeWithoutImportanceResult;
    }

    if (templateResult.error) {
      setError(templateResult.error.message);
      setLoading(false);
      return;
    }

    if (taskResult.error) {
      setError(taskResult.error.message);
      setLoading(false);
      return;
    }

    if (recordResult.error) {
      setError(recordResult.error.message);
      setLoading(false);
      return;
    }

    setTemplates((templateResult.data ?? []).map((row) => normalizeHabitTemplateRow(row as Record<string, unknown>)));
    setTasks((taskResult.data ?? []) as unknown as HabitTaskLike[]);
    setRecords((recordResult.data ?? []).map((row) => normalizeHabitRecordRow(row as Record<string, unknown>)));
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [rangeBounds.startDate, rangeBounds.endDate]);

  useEffect(() => {
    if (!availableRangeModes.includes(rangeMode)) {
      setRangeMode(availableRangeModes[0]);
    }
  }, [availableRangeModes, rangeMode]);

  const summaries = useMemo(
    () => buildDailySummaries(tasks, records, templates, rangeBounds.endDate, rangeBounds.startDate),
    [records, rangeBounds.endDate, rangeBounds.startDate, tasks, templates]
  );
  const heatmapStartDate = useMemo(() => parseDateInput(rangeBounds.startDate) ?? undefined, [rangeBounds.startDate]);
  const heatmapEndDate = useMemo(() => parseDateInput(rangeBounds.endDate) ?? undefined, [rangeBounds.endDate]);
  const heatmap = useMemo(
    () => buildHeatmapWeeks(summaries, metric, 12, heatmapEndDate, heatmapStartDate),
    [heatmapEndDate, heatmapStartDate, metric, summaries]
  );
  const periodPoints = useMemo(() => buildPeriodPoints(summaries, period, metric), [metric, period, summaries]);
  const newestPeriodPoints = useMemo(
    () => [...periodPoints].sort((left, right) => right.endDate.localeCompare(left.endDate)),
    [periodPoints]
  );
  const newestHeatmapWeeks = useMemo(
    () => [...heatmap.weeks]
      .filter((week) => week.days.some((day) => !day.outsideRange))
      .sort((left, right) => {
        const leftLatest = [...left.days].reverse().find((day) => !day.outsideRange)?.date ?? '';
        const rightLatest = [...right.days].reverse().find((day) => !day.outsideRange)?.date ?? '';
        return rightLatest.localeCompare(leftLatest);
      }),
    [heatmap.weeks]
  );
  const summaryMap = useMemo(
    () => new Map(summaries.map((summary) => [summary.date, summary])),
    [summaries]
  );
  const selectedSummary = summaryMap.get(selectedDate) ?? null;

  const activeDays = useMemo(
    () => summaries.filter((summary) => summary.activity > 0).length,
    [summaries]
  );

  const maxValue = heatmap.maxValue;

  const metricSummary = useMemo(() => {
    if (!summaries.length) {
      return 0;
    }

    const total = summaries.reduce((sum, summary) => {
      switch (metric) {
        case 'task_done':
          return sum + (summary.taskCount > 0 ? (summary.taskDoneCount / summary.taskCount) * 100 : 0);
        case 'record_count':
          return sum + summary.completionRatioAvg * 100;
        case 'habit_done':
          return sum + (summary.dueHabits.length > 0 ? (summary.habitDoneCount / summary.dueHabits.length) * 100 : 0);
        case 'score_sum':
          return sum + summary.weightedCompletionRatio * 100;
        case 'activity':
        default:
          return sum + summary.activity;
      }
    }, 0);

    return total / summaries.length;
  }, [metric, summaries]);

  const openDateDetail = (date: string, type: DetailModalType = 'all') => {
    setSelectedDate(date);
    setSelectedPeriodPoint(null);
    setDetailModalType(type);
  };

  const openPeriodDetail = (point: PeriodPoint) => {
    setSelectedDate(point.endDate);
    setSelectedPeriodPoint(point);
    setDetailModalType('all');
  };

  const selectedRangeSummaries = useMemo(() => {
    if (!selectedPeriodPoint) {
      return [];
    }

    return summaries
      .filter((summary) => (
        selectedPeriodPoint.startDate <= summary.date && summary.date <= selectedPeriodPoint.endDate
      ))
      .sort((left, right) => right.date.localeCompare(left.date));
  }, [selectedPeriodPoint, summaries]);

  const selectedRangeStats = useMemo(() => {
    if (!selectedRangeSummaries.length) {
      return null;
    }

    return {
      taskCount: selectedRangeSummaries.reduce((sum, summary) => sum + summary.taskCount, 0),
      taskDoneCount: selectedRangeSummaries.reduce((sum, summary) => sum + summary.taskDoneCount, 0),
      habitCount: selectedRangeSummaries.reduce((sum, summary) => sum + summary.dueHabits.length, 0),
      habitDoneCount: selectedRangeSummaries.reduce((sum, summary) => sum + summary.habitDoneCount, 0),
      weightedCompletionRatio: selectedRangeSummaries.reduce((sum, summary) => sum + summary.weightedCompletionRatio, 0) / selectedRangeSummaries.length
    };
  }, [selectedRangeSummaries]);

  return (
    <AppShell
      title='热力图'
      description='按不同时间范围查看完成度，支持单日和区间明细。'
      activeHref='/heatmap'
      onSignOut={async () => {
        await supabase.auth.signOut();
        router.replace('/auth/login');
      }}
    >
      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
        <StatCard label='统计口径' value={metricOptions.find((option) => option.value === metric)?.label ?? metric} hint='可切换不同指标' />
        <StatCard label='活跃天数' value={activeDays} hint='当前范围内有活动的日期' />
        <StatCard label='最高完成度' value={`${maxValue.toFixed(1)}%`} hint='当前口径下的颜色基准' />
        <StatCard label='平均完成度' value={`${metricSummary.toFixed(1)}%`} hint='所有日期平均' />
      </div>

      <Panel title='统计粒度' description='控制热力图和总榜折线中每个点代表的时间区间。'>
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

      <Panel title='时间范围' description='按天可查看某一年；更大粒度可查看更长周期。'>
        <div className='flex flex-wrap items-center gap-2'>
          {availableRangeModes.map((option) => (
            <button
              key={option}
              type='button'
              onClick={() => setRangeMode(option)}
              className={`rounded-xl px-3 py-2 text-sm font-medium ${rangeMode === option ? 'bg-slate-900 text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
            >
              {rangeModeLabels[option]}
            </button>
          ))}
          {rangeMode === 'year' && (
            <select
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
              className='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700'
            >
              {availableYears.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          )}
        </div>
      </Panel>

      <Panel title='总榜分数'>
        <ScoreLine values={periodPoints.map((point) => ({ label: point.label, score: point.score }))} />
      </Panel>

      <div className='grid gap-4 xl:grid-cols-[1.2fr_0.8fr]'>
        <Panel title='统计口径' description='切换热力图的聚合方式。'>
          <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-1'>
            {metricOptions.map((option) => (
              <button
                key={option.value}
                type='button'
                onClick={() => setMetric(option.value)}
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  metric === option.value
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className='block text-sm font-semibold'>{option.label}</span>
                <span className={`mt-1 block text-xs ${metric === option.value ? 'text-slate-200' : 'text-slate-500'}`}>
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title={rangeMode === 'year' ? `${selectedYear} 年` : rangeModeLabels[rangeMode]}
          description={`范围：${heatmap.rangeStart} 至 ${heatmap.rangeEnd}`}
        >
          {loading && <p className='text-sm text-slate-500'>加载中…</p>}
          {!loading && !summaries.length && (
            <div className='rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500'>
              还没有任何历史数据。
            </div>
          )}

          {period === 'day' && (
            <div>
              <div className='mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500'>
                <span>按周显示，最近一周在上</span>
                <span className='rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500'>
                  {metricOptions.find((option) => option.value === metric)?.label}
                </span>
              </div>

              <div className='space-y-1'>
                {newestHeatmapWeeks.map((week) => {
                  const visibleDays = week.days.filter((day) => !day.outsideRange);
                  const weekStart = visibleDays[0]?.date ?? week.days[0]?.date;
                  const weekEnd = visibleDays.at(-1)?.date ?? week.days.at(-1)?.date;

                  return (
                    <div key={week.index} className='grid grid-cols-[minmax(88px,auto)_repeat(7,18px)] items-center gap-1 text-xs text-slate-500'>
                      <span className='truncate pr-2 text-[10px]'>{weekStart?.slice(5)} 至 {weekEnd?.slice(5)}</span>
                      {week.days.map((day) => {
                        const parsed = parseDateInput(day.date);
                        const dayLabel = parsed ? compactWeekLabels[parsed.getUTCDay()] : '';
                        return (
                          <button
                            key={day.date}
                            type='button'
                            disabled={day.outsideRange}
                            onClick={() => !day.outsideRange && openDateDetail(day.date)}
                            title={`${day.date} · 周${dayLabel} · 完成度 ${day.value.toFixed(1)}%`}
                            style={completionHeatmapStyle(day.outsideRange ? 0 : day.value)}
                            className={`h-[18px] w-[18px] rounded-[4px] border border-white/80 transition hover:scale-110 disabled:cursor-default disabled:opacity-20 ${
                              selectedDate === day.date ? 'ring-2 ring-slate-900 ring-offset-1' : ''
                            }`}
                          >
                            <span className='sr-only'>
                              {day.date} {day.value}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {period !== 'day' && (
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4'>
              {newestPeriodPoints.map((point) => {
                return (
                  <button
                    key={point.key}
                    type='button'
                    onClick={() => openPeriodDetail(point)}
                    style={completionHeatmapStyle(point.value)}
                    className='rounded-2xl p-3 text-left text-sm'
                    title={`${point.startDate} 至 ${point.endDate}`}
                  >
                    <span className='block font-semibold'>{point.label}</span>
                    <span className='mt-1 block text-xs'>完成度 {point.value.toFixed(1)}%</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className='mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500'>
            <span>0</span>
            <span className='h-3 w-40 rounded-full border border-slate-200' style={{ background: 'linear-gradient(90deg, rgb(255 255 255), rgb(247 252 247) 5%, rgb(198 230 200) 25%, rgb(91 176 103) 50%, rgb(25 130 63) 75%, rgb(5 63 34) 99%)' }} />
            <span>99%</span>
            <span className='rounded-full px-2 py-1 text-amber-950' style={{ backgroundColor: '#facc15', boxShadow: 'inset 0 0 0 1px #ca8a04' }}>100%</span>
          </div>
        </Panel>
      </div>

      {detailModalType && selectedPeriodPoint && selectedRangeStats && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
          <div className='max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <h2 className='text-lg font-semibold text-slate-900'>
                  区间明细 · {selectedPeriodPoint.startDate} 至 {selectedPeriodPoint.endDate}
                </h2>
                <p className='mt-1 text-sm text-slate-500'>
                  区间平均加权完成度 {(selectedRangeStats.weightedCompletionRatio * 100).toFixed(1)}%
                </p>
              </div>
              <button
                type='button'
                onClick={() => {
                  setDetailModalType(null);
                  setSelectedPeriodPoint(null);
                }}
                className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'
              >
                关闭
              </button>
            </div>

            <div className='mt-5 grid gap-3 sm:grid-cols-3'>
              <div className='rounded-2xl bg-slate-50 p-4'>
                <p className='text-sm text-slate-500'>应完成任务</p>
                <p className='mt-2 text-2xl font-semibold'>{selectedRangeStats.taskDoneCount}/{selectedRangeStats.taskCount}</p>
              </div>
              <div className='rounded-2xl bg-slate-50 p-4'>
                <p className='text-sm text-slate-500'>应完成习惯</p>
                <p className='mt-2 text-2xl font-semibold'>{selectedRangeStats.habitDoneCount}/{selectedRangeStats.habitCount}</p>
              </div>
              <div className='rounded-2xl bg-slate-50 p-4'>
                <p className='text-sm text-slate-500'>完成度</p>
                <p className='mt-2 text-2xl font-semibold'>{(selectedRangeStats.weightedCompletionRatio * 100).toFixed(1)}%</p>
              </div>
            </div>

            <div className='mt-5 space-y-2'>
              {selectedRangeSummaries.map((summary) => (
                <button
                  key={summary.date}
                  type='button'
                  onClick={() => openDateDetail(summary.date)}
                  className='w-full rounded-xl border border-slate-100 bg-slate-50 p-3 text-left transition hover:border-slate-300 hover:bg-white'
                >
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <p className='font-medium text-slate-900'>{summary.date}</p>
                    <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>
                      完成度 {(summary.weightedCompletionRatio * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className='mt-1 text-sm text-slate-500'>
                    任务 {summary.taskDoneCount}/{summary.taskCount} · 习惯 {summary.habitDoneCount}/{summary.dueHabits.length}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {detailModalType && selectedSummary && !selectedPeriodPoint && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'>
          <div className='max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <h2 className='text-lg font-semibold text-slate-900'>当天明细 · {selectedDate}</h2>
                <p className='mt-1 text-sm text-slate-500'>
                  加权完成度 {(selectedSummary.weightedCompletionRatio * 100).toFixed(1)}%
                </p>
              </div>
              <button
                type='button'
                onClick={() => setDetailModalType(null)}
                className='rounded-xl border border-slate-200 px-3 py-1.5 text-sm'
              >
                关闭
              </button>
            </div>

            {(detailModalType === 'all' || detailModalType === 'tasks') && (
              <div className='mt-5'>
                <div className='flex items-center justify-between gap-3'>
                  <h3 className='text-sm font-semibold text-slate-900'>应完成任务</h3>
                  <span className='text-xs text-slate-500'>
                    {selectedSummary.taskDoneCount}/{selectedSummary.taskCount}
                  </span>
                </div>
                <div className='mt-2 space-y-2'>
                  {selectedSummary.tasks.length === 0 && (
                    <p className='rounded-xl bg-slate-50 p-3 text-sm text-slate-500'>当天没有应完成任务。</p>
                  )}
                  {selectedSummary.tasks.map((task) => (
                    <div key={task.id} className='rounded-xl border border-slate-100 bg-slate-50 p-3'>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <p className={`font-medium ${task.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                          {task.title}
                        </p>
                        <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>
                          重要值 {task.importance ?? 50} · {priorityLabels[task.priority]}
                        </span>
                      </div>
                      {isRangeTask(task) ? (
                        <>
                          <p className='mt-1 text-sm text-slate-600'>
                            区间 {taskRangeStart(task)} 至 {taskRangeEnd(task)} · 完成度 {Math.round(taskCompletionRatio(task) * 100)}%
                            {task.target_value ? ` · 进度 ${task.progress_value ?? 0}/${task.target_value}` : ''}
                          </p>
                          {task.description && <p className='mt-1 text-sm text-slate-500'>{task.description}</p>}
                        </>
                      ) : task.description && <p className='mt-1 text-sm text-slate-600'>{task.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(detailModalType === 'all' || detailModalType === 'habits') && (
              <div className='mt-5'>
                <div className='flex items-center justify-between gap-3'>
                  <h3 className='text-sm font-semibold text-slate-900'>应完成习惯</h3>
                  <span className='text-xs text-slate-500'>
                    {selectedSummary.habitDoneCount}/{selectedSummary.dueHabits.length}
                  </span>
                </div>
                <div className='mt-2 space-y-2'>
                  {selectedSummary.dueHabits.length === 0 && (
                    <p className='rounded-xl bg-slate-50 p-3 text-sm text-slate-500'>当天没有应完成习惯。</p>
                  )}
                  {selectedSummary.dueHabits.map((habit) => (
                    <div key={habit.template.id} className='rounded-xl border border-slate-100 bg-slate-50 p-3'>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <p className='font-medium text-slate-900'>{habit.template.title}</p>
                        <span className='rounded-full bg-white px-2 py-1 text-xs text-slate-600'>
                          重要值 {habit.importance}
                        </span>
                      </div>
                      <p className='mt-1 text-sm text-slate-600'>
                        实际值 {formatHabitValue(habit.actualValue)} · 完成度 {(habit.completionRatio * 100).toFixed(1)}%
                        {habit.record ? ' · 已记录' : ' · 无记录按 0'}
                      </p>
                      {habit.record?.notes && <p className='mt-1 text-sm text-slate-500'>{habit.record.notes}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className='rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700'>{error}</p>}
    </AppShell>
  );
}
