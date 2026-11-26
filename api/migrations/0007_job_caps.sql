-- 0007: per-key negotiated async size caps. NULL max_job_bytes = default
-- (20 MiB, enforced in the worker). jobs.cap_bytes snapshots the effective
-- cap at creation so the consumer enforces exactly what was admitted even
-- when the key's cap changes later. Both additive, no table rebuild.

ALTER TABLE keys ADD COLUMN max_job_bytes INTEGER;
ALTER TABLE jobs ADD COLUMN cap_bytes INTEGER;
