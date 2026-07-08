'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { AppShell, Panel, StatCard } from '@/components/app-shell';
import { commitImportPreview, loadImportPreview } from '@/lib/habit-io';
import { supabase } from '@/lib/supabase/client';
import type { HabitImportJobRow } from '@/types/habit';
import type { ImportPreview } from '@/types/import';

const kindLabels: Record<string, string> = {
  tasks: '任务',
  habit_templates: '习惯模板',
  habit_records: '习惯记录',
  unknown: '未识别'
};

const previewHead = (rows: string[][], count = 3) => rows.slice(0, count);

const jobStatusLabels: Record<string, string> = {
  draft: '草稿',
  preview: '预览中',
  processing: '处理中',
  completed: '已完成',
  completed_with_errors: '部分完成',
  failed: '失败',
  cancelled: '已取消'
};

export default function ImportClient() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jobs, setJobs] = useState<HabitImportJobRow[]>([]);
  const [importResult, setImportResult] = useState<{
    jobId: string;
    templateCount: number;
    recordCount: number;
    taskCount: number;
    itemCount: number;
    successRows: number;
    failedRows: number;
    status: string;
    warnings: string[];
  } | null>(null);

  const loadInitialData = async () => {
    setLoading(true);
    const {
      data: { user: currentUser }
    } = await supabase.auth.getUser();

    if (!currentUser) {
      router.replace('/auth/login');
      return;
    }

    setUser(currentUser);

    const { data, error: jobError } = await supabase
      .from('import_jobs')
      .select(
        'id,user_id,source_name,source_type,status,total_rows,success_rows,failed_rows,warning_rows,config,created_at,finished_at,updated_at'
      )
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (jobError) {
      setError(jobError.message);
      setLoading(false);
      return;
    }

    setJobs((data ?? []) as HabitImportJobRow[]);
    setLoading(false);
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError('');
    setImportResult(null);

    if (!file) {
      setPreview(null);
      return;
    }

    setPreviewLoading(true);
    try {
      const nextPreview = await loadImportPreview(file);
      setPreview(nextPreview);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : '导入预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  const refreshJobs = async () => {
    if (!user) {
      return;
    }

    const { data, error: jobError } = await supabase
      .from('import_jobs')
      .select(
        'id,user_id,source_name,source_type,status,total_rows,success_rows,failed_rows,warning_rows,config,created_at,finished_at,updated_at'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!jobError) {
      setJobs((data ?? []) as HabitImportJobRow[]);
    }
  };

  const handleConfirmImport = async () => {
    if (!user || !preview) {
      return;
    }

    setImporting(true);
    setError('');
    setMessage('');

    try {
      const result = await commitImportPreview(supabase, user.id, preview);
      setImportResult({
        jobId: result.job?.id ?? '',
        templateCount: result.templateCount,
        recordCount: result.recordCount,
        taskCount: result.taskCount,
        itemCount: result.itemCount,
        successRows: result.successRows,
        failedRows: result.failedRows,
        status: result.status,
        warnings: result.warnings
      });
      setMessage('导入完成');
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const summary = useMemo(() => {
    if (!preview) {
      return {
        files: 0,
        templates: 0,
        records: 0,
        tasks: 0,
        warnings: 0
      };
    }

    return {
      files: preview.files.length,
      templates: preview.templateDrafts.length,
      records: preview.recordDrafts.length,
      tasks: preview.taskDrafts.length,
      warnings: preview.warnings.length
    };
  }, [preview]);

  return (
    <AppShell
      title='导入'
      description='上传 CSV 或 ZIP，自动预览字段映射和校验结果，确认后写入习惯模板、每日记录和任务。'
      activeHref='/import'
      onSignOut={async () => {
        await supabase.auth.signOut();
        router.replace('/auth/login');
      }}
    >
      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-5'>
        <StatCard label='文件数' value={summary.files} hint='CSV / ZIP 内解析出的文件' />
        <StatCard label='模板数' value={summary.templates} hint='自动识别或占位创建的模板' />
        <StatCard label='记录数' value={summary.records} hint='每日习惯记录' />
        <StatCard label='任务数' value={summary.tasks} hint='如包含 tasks.csv' />
        <StatCard label='警告' value={summary.warnings} hint='解析或映射中的提示' />
      </div>

      <div className='grid gap-4 xl:grid-cols-[1fr_0.85fr]'>
        <Panel
          title='上传文件'
          description='支持单个 CSV，或包含 tasks.csv、habit-templates.csv、habit-records.csv 的 ZIP。'
          actions={
            <label className='cursor-pointer rounded-2xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800'>
              选择文件
              <input
                type='file'
                accept='.csv,.zip'
                className='hidden'
                onChange={handleFile}
              />
            </label>
          }
        >
          <div className='rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600'>
            <p className='font-medium text-slate-900'>支持的 CSV</p>
            <ol className='mt-2 list-decimal space-y-1 pl-5'>
              <li>`habit-templates.csv`：习惯模板，含起始日期、终止日期、频率和目标。</li>
              <li>`habit-records.csv`：每日记录，通过 `template_source_key` 匹配模板。</li>
              <li>`tasks.csv`：一次性任务。导出 ZIP 可直接再次导入。</li>
            </ol>
          </div>

          {previewLoading && <p className='mt-3 text-sm text-slate-500'>正在解析预览…</p>}
          {selectedFile && !previewLoading && (
            <p className='mt-3 text-sm text-slate-500'>
              已选择：<span className='font-medium text-slate-900'>{selectedFile.name}</span>
            </p>
          )}

          {preview && (
            <div className='mt-4 space-y-4'>
              <div className='grid gap-2 md:grid-cols-2'>
                {preview.files.map((file) => (
                  <div key={file.path} className='rounded-2xl border border-slate-100 bg-white p-4'>
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <div>
                        <p className='text-sm font-semibold text-slate-900'>{file.name}</p>
                        <p className='text-xs text-slate-500'>{file.path}</p>
                      </div>
                      <span className='rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600'>
                        {kindLabels[file.kind] ?? file.kind}
                      </span>
                    </div>

                    <p className='mt-2 text-xs text-slate-500'>
                      {file.rows.length} 行 · {file.headers.length} 列
                    </p>

                    <div className='mt-3 overflow-x-auto rounded-xl border border-slate-100'>
                      <table className='min-w-full text-left text-xs'>
                        <thead className='bg-slate-50 text-slate-500'>
                          <tr>
                            {file.headers.map((header) => (
                              <th key={header} className='px-2 py-1.5 font-medium'>
                                {header || '（空列）'}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewHead(file.rows).map((row, index) => (
                            <tr key={`${file.path}-${index}`} className='border-t border-slate-100'>
                              {row.map((cell, cellIndex) => (
                                <td key={`${file.path}-${index}-${cellIndex}`} className='px-2 py-1.5 text-slate-600'>
                                  {cell || '—'}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>

              <div className='rounded-2xl border border-slate-100 bg-white p-4'>
                <h3 className='text-sm font-semibold text-slate-900'>自动映射与校验</h3>
                <div className='mt-3 space-y-3'>
                  {preview.mappingNotes.length > 0 && (
                    <ul className='space-y-1 text-sm text-slate-600'>
                      {preview.mappingNotes.map((note) => (
                        <li key={note} className='rounded-xl bg-slate-50 px-3 py-2'>
                          {note}
                        </li>
                      ))}
                    </ul>
                  )}

                  {preview.files.map((file) => (
                    <div key={`${file.path}-mapping`} className='rounded-2xl bg-slate-50 p-3 text-sm text-slate-600'>
                      <p className='font-medium text-slate-900'>{file.name}</p>
                      {file.kind === 'habit_templates' && (
                        <p className='mt-1'>
                          {'source_key / title / frequency_rule / target_value / start_date / end_date 会写入习惯模板表。'}
                        </p>
                      )}
                      {file.kind === 'tasks' && (
                        <p className='mt-1'>
                          {'id / title / task_date / status / priority 会写入一次性任务表。'}
                        </p>
                      )}
                      {file.kind === 'habit_records' && (
                        <p className='mt-1'>
                          {'template_source_key / record_date / value_text / value_number 会写入每日记录表。'}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className='flex flex-wrap gap-3'>
                <button
                  type='button'
                  onClick={handleConfirmImport}
                  disabled={!preview || importing}
                  className='rounded-2xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50'
                >
                  {importing ? '导入中…' : '确认导入'}
                </button>
                <button
                  type='button'
                  onClick={() => {
                    setPreview(null);
                    setSelectedFile(null);
                    setImportResult(null);
                  }}
                  className='rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
                >
                  清空预览
                </button>
              </div>

              {preview.warnings.length > 0 && (
                <div className='rounded-2xl border border-amber-200 bg-amber-50 p-4'>
                  <h3 className='text-sm font-semibold text-amber-900'>警告</h3>
                  <ul className='mt-2 space-y-1 text-sm text-amber-900'>
                    {preview.warnings.map((warning) => (
                      <li key={warning}>• {warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title='最近导入作业' description='用于回溯导入结果和后续重试。'>
          {loading && <p className='text-sm text-slate-500'>加载中…</p>}
          <div className='space-y-3'>
            {jobs.length === 0 && !loading && (
              <div className='rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500'>
                暂无导入作业。
              </div>
            )}

            {jobs.map((job) => (
              <div key={job.id} className='rounded-2xl border border-slate-100 bg-slate-50 p-4'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div>
                    <p className='text-sm font-semibold text-slate-900'>{job.source_name}</p>
                    <p className='text-xs text-slate-500'>{job.created_at}</p>
                  </div>
                  <span className='rounded-full bg-white px-2.5 py-1 text-xs text-slate-600'>
                    {jobStatusLabels[job.status] ?? job.status}
                  </span>
                </div>
                <p className='mt-2 text-xs text-slate-500'>
                  {job.success_rows}/{job.total_rows} · 警告 {job.warning_rows} · 失败 {job.failed_rows}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {importResult && (
        <Panel title='导入结果' description='本次导入写入的摘要。'>
          <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
            <StatCard label='作业 ID' value={importResult.jobId.slice(0, 8) || '无'} hint='完整 ID 记录在导入作业表中' />
            <StatCard label='模板写入' value={importResult.templateCount} />
            <StatCard label='记录写入' value={importResult.recordCount} />
            <StatCard label='任务写入' value={importResult.taskCount} />
            <StatCard label='成功行' value={importResult.successRows} />
            <StatCard label='失败行' value={importResult.failedRows} />
            <StatCard label='状态' value={jobStatusLabels[importResult.status] ?? importResult.status} />
          </div>
          {importResult.warnings.length > 0 && (
            <div className='mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900'>
              <p className='font-semibold'>导入警告</p>
              <ul className='mt-2 space-y-1'>
                {importResult.warnings.map((warning) => (
                  <li key={warning}>• {warning}</li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      {error && <p className='rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700'>{error}</p>}
      {message && <p className='rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700'>{message}</p>}
    </AppShell>
  );
}
