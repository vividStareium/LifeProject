export type FrequencyKind = 'daily' | 'weekly' | 'custom';

export type HabitCompletionState = 'done' | 'missed' | 'unknown' | 'recorded';

export type HabitSourceType = 'manual' | 'csv' | 'zip' | 'export';

export type HabitGroupRow = {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
};

export type HabitTemplateRow = {
  id: string;
  user_id: string;
  group_id?: string | null;
  source_key: string;
  source_name: string | null;
  source_type: HabitSourceType;
  title: string;
  description: string | null;
  question: string | null;
  frequency_kind: FrequencyKind;
  frequency_rule: Record<string, unknown>;
  unit: string | null;
  target_type: string | null;
  target_value: number | null;
  color: string | null;
  sort_order: number;
  start_date: string;
  end_date: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type HabitDailyRecordRow = {
  id: string;
  user_id: string;
  template_id: string;
  record_date: string;
  value_text: string | null;
  value_number: number | null;
  completion_state: HabitCompletionState;
  notes: string | null;
  source_type: HabitSourceType;
  source_key: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type HabitImportJobRow = {
  id: string;
  user_id: string;
  source_name: string;
  source_type: 'csv' | 'zip' | 'export';
  status:
    | 'draft'
    | 'preview'
    | 'processing'
    | 'completed'
    | 'completed_with_errors'
    | 'failed'
    | 'cancelled';
  total_rows: number;
  success_rows: number;
  failed_rows: number;
  warning_rows: number;
  config: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
  updated_at: string;
};

export type HabitImportJobItemRow = {
  id: string;
  job_id: string;
  user_id: string;
  source_name: string;
  sheet_name: string | null;
  source_key: string | null;
  raw_payload: Record<string, unknown>;
  mapped_payload: Record<string, unknown>;
  status: 'pending' | 'ok' | 'skipped' | 'error';
  error_message: string | null;
  created_at: string;
};

export type HabitTaskLike = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  task_date: string;
  task_type?: 'single' | 'range' | null;
  range_start_date?: string | null;
  range_end_date?: string | null;
  progress_value?: number | null;
  target_value?: number | null;
  start_time: string | null;
  end_time: string | null;
  status: 'todo' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  importance?: number | null;
  category: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
