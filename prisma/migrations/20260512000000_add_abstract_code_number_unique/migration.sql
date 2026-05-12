-- Add unique constraint on (event_id, code_number) to prevent duplicate numeric portions
-- NULL values are excluded so un-finalized abstracts don't conflict
CREATE UNIQUE INDEX IF NOT EXISTS abstracts_event_id_code_number_key
ON abstracts (event_id, code_number)
WHERE code_number IS NOT NULL;
