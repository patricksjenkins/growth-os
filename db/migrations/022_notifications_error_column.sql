-- 022: Add error column to notifications table
-- Agents write error messages on failure; column was missing from 021
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS error TEXT;
