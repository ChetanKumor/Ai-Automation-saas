-- Add 'running' to workflow_executions status CHECK for claim-based dedup.
-- Table is empty in production — this is a no-op alter.

ALTER TABLE workflow_executions
  DROP CONSTRAINT IF EXISTS workflow_executions_status_check;

ALTER TABLE workflow_executions
  ADD CONSTRAINT workflow_executions_status_check
  CHECK (status IN ('running', 'success', 'failed', 'skipped'));
