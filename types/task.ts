export type TaskStatus = 'todo' | 'done' | 'cancelled';

export type TaskPriority = 'low' | 'medium' | 'high';

export type TaskType = 'single' | 'range';

export type TaskGroupRow = {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  task_date: string;
  task_type?: TaskType | null;
  range_start_date?: string | null;
  range_end_date?: string | null;
  progress_value?: number | null;
  target_value?: number | null;
  start_time: string | null;
  end_time: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  importance?: number | null;
  category: string | null;
  group_id?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
