-- Allow tasks to be assigned directly to a system user (not only a supervisor)
ALTER TABLE sales_tasks
  ADD COLUMN IF NOT EXISTS assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_tasks_assignee_user
  ON sales_tasks(assignee_user_id);
