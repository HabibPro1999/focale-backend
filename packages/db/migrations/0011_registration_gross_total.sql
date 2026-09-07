-- Creation/repricing previously stored priceBreakdown.total (net) in total_amount,
-- although settlement and sponsorship linking interpret total_amount as gross.
-- Repair only rows whose saved breakdown proves they use the old net convention.
-- Already-gross rows and totals with manual/floor adjustments remain unchanged.
UPDATE registrations
SET total_amount = (price_breakdown->>'subtotal')::integer,
    updated_at = CURRENT_TIMESTAMP
WHERE sponsorship_amount > 0
  AND jsonb_typeof(price_breakdown->'subtotal') = 'number'
  AND jsonb_typeof(price_breakdown->'total') = 'number'
  AND total_amount = (price_breakdown->>'total')::integer
  AND (price_breakdown->>'subtotal')::integer > total_amount;
