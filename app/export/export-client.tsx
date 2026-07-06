'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import { buildDailySummaries } from '@/lib/analytics';
import { buildExportJson, buildExportZip } from '@/lib/habit-io';
import { supabase } from '@/lib/supabase/client';
import { getBeijingDateInput } from '@/lib/date';
import { normalizeHabitRecordRow, normalizeHabitTemplateRow } from '@/lib/normalize-db-rows';
import type { HabitDailyRecordRow, HabitTaskLike, HabitTemplateRow } from '@/types/habit';

const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export default function ExportClient() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportingZip, setExportingZip] = useState(false);
  const [exportingJson, setExportingJson] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [templates, setTemplates] = useState<HabitTemplateRow[]>([]);
  const [tasks, setTasks] = useState<HabitTaskLike[]>([]);
  const [records, setRecords] = useState<HabitDailyRecordRow[]>([]);

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

    const taskSelectWithImportance =
      'id,user_id,title,description,task_date,start_time,end_time,status,priority,importance,category,created_at,updated_at,deleted_at';
    const taskSelectWithoutImportance =
      'id,user_id,title,description,task_date,start_time,end_time,status,priority,category,created_at,updated_at,deleted_at';
    const buildTaskQuery = (selectFields: string) => supabase
      .from('tasks')
      .select(selectFields)
      .eq('user_id', currentUser.id)
      .order('task_date', { ascending: false })
      .order('created_at', { ascending: false });

    const [templateResult, firstTaskResult, recordResult] = await Promise.all([
      supabase
        .from('habit_templates')
        .select(
          'id,user_id,source_key,source_name,source_type,title,description,question,frequency_kind,frequency_rule,unit,target_type,target_value,color,sort_order,archived_at,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .order('sort_order', { ascending: true }),
      buildTaskQuery(taskSelectWithImportance),
      supabase
        .from('habit_daily_records')
        .select(
          'id,user_id,template_id,record_date,value_text,value_number,completion_state,notes,source_type,source_key,raw_payload,created_at,updated_at'
        )
        .eq('user_id', currentUser.id)
        .order('record_date', { ascending: false })
        .order('created_at', { ascending: false })
    ]);
    const taskResult = firstTaskResult.error && firstTaskResult.error.message.includes('importance')
      ? await buildTaskQuery(taskSelectWithoutImportance)
      : firstTaskResult;

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
  }, []);

  const summaries = useMemo(() => buildDailySummaries(tasks, records, templates), [records, tasks, templates]);
  const totalTasks = tasks.length;
  const totalTemplates = templates.length;
  const totalRecords = records.length;
  const activeDays = summaries.filter((summary) => summary.activity > 0).length;

  const handleExportZip = async () => {
    setExportingZip(true);
    setError('');
    try {
      const blob = await buildExportZip({ tasks, templates, records });
      downloadBlob(`life-project-backup-${getBeijingDateInput()}.zip`, blob);
      setMessage('ZIP 备份已生成');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ZIP 导出失败');
    } finally {
      setExportingZip(false);
    }
  };

  const handleExportJson = async () => {
    setExportingJson(true);
    setError('');
    try {
      const json = buildExportJson({ tasks, templates, records });
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      downloadBlob(`life-project-backup-${getBeijingDateInput()}.json`, blob);
      setMessage('JSON 备份已生成');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'JSON 导出失败');
    } finally {
      setExportingJson(false);
    }
  };

  return (
    <AppShell
      title='导出'
      description='导出当前账号中的一次性任务、周期模板、周期记录以及热力图统计，ZIP 包内同时包含规范化 CSV 与 Loop 兼容文件。'
      activeHref='/export'
      onSignOut={async () => {
        await supabase.auth.signOut();
        router.replace('/auth/login');
      }}
    >
      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
        <StatCard label='任务' value={totalTasks} hint='包含软删除任务' />
        <StatCard label='模板' value={totalTemplates} hint='周期习惯模板' />
        <StatCard label='记录' value={totalRecords} hint='最近 18 个月记录' />
        <StatCard label='活跃天数' value={activeDays} hint='热力图可视化范围' />
      </div>

      <div className='grid gap-4 xl:grid-cols-[1.1fr_0.9fr]'>
        <Panel
          title='导出备份'
          description='推荐先用 ZIP 作为完整备份，必要时再用 JSON 作为程序化导出。'
        >
          <div className='grid gap-3 md:grid-cols-2'>
            <button
              type='button'
              onClick={handleExportZip}
              disabled={exportingZip || loading}
              className='rounded-2xl bg-slate-900 px-4 py-4 text-left text-white transition hover:bg-slate-800 disabled:opacity-50'
            >
              <span className='block text-base font-semibold'>
                {exportingZip ? '生成 ZIP 中…' : '下载 ZIP 备份'}
              </span>
              <span className='mt-1 block text-sm text-slate-200'>
                含 CSV、JSON、Loop 兼容 legacy 文件，可再次导入。
              </span>
            </button>

            <button
              type='button'
              onClick={handleExportJson}
              disabled={exportingJson || loading}
              className='rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:bg-slate-50 disabled:opacity-50'
            >
              <span className='block text-base font-semibold text-slate-900'>
                {exportingJson ? '生成 JSON 中…' : '下载 JSON 备份'}
              </span>
              <span className='mt-1 block text-sm text-slate-600'>
                适合程序化备份、调试和后续解析。
              </span>
            </button>
          </div>

          <div className='mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-600'>
            <p className='font-medium text-slate-900'>ZIP 内容</p>
            <ul className='mt-2 list-disc space-y-1 pl-5'>
              <li>`tasks.csv` - 一次性任务</li>
              <li>`habit-templates.csv` - 周期模板</li>
              <li>`habit-records.csv` - 每日记录，含实际值、归一化值、完成状态、完成度和分数</li>
              <li>`habit-scores.csv` - 每日习惯分数表</li>
              <li>`heatmap.json` / `summary.json` - 统计和可视化数据</li>
              <li>`loop-habits-legacy/` - 兼容 Loop Habits 的 legacy CSV</li>
            </ul>
          </div>
        </Panel>

        <Panel title='导出校验' description='导出结果可直接再次导入，形成闭环。'>
          <div className='space-y-3 text-sm text-slate-600'>
            <div className='rounded-2xl border border-slate-100 bg-slate-50 p-4'>
              <p className='font-medium text-slate-900'>可再次导入</p>
              <p className='mt-1'>
                ZIP 里包含规范化 CSV 与 legacy 兼容文件，导入页会自动识别并恢复模板、记录和任务。
              </p>
            </div>
            <div className='rounded-2xl border border-slate-100 bg-slate-50 p-4'>
              <p className='font-medium text-slate-900'>热力图范围</p>
              <p className='mt-1'>
                {summaries.length ? `${summaries[0].date} - ${summaries[summaries.length - 1].date}` : '暂无数据'}
              </p>
            </div>
            <div className='rounded-2xl border border-slate-100 bg-slate-50 p-4'>
              <p className='font-medium text-slate-900'>说明</p>
              <p className='mt-1'>
                软删除任务也会导出，方便迁移和恢复；记录表按用户范围与日期范围导出。
              </p>
            </div>
          </div>
        </Panel>
      </div>

      {loading && <p className='rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-500'>加载中…</p>}
      {error && <p className='rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700'>{error}</p>}
      {message && <p className='rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700'>{message}</p>}
    </AppShell>
  );
}
