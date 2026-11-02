-- migrate: transaction per-statement
-- migrate: idempotent
-- migrate: verify SELECT count(*) = 12 FROM information_schema.columns WHERE table_schema = 'public' AND numeric_scale = 4 AND ((table_name = 'event_pricing' AND column_name = 'base_price') OR (table_name = 'event_access' AND column_name IN ('price', 'companion_price')) OR (table_name = 'registrations' AND column_name IN ('total_amount', 'paid_amount', 'base_amount', 'discount_amount', 'access_amount', 'sponsorship_amount')) OR (table_name = 'payment_transaction' AND column_name = 'amount') OR (table_name = 'sponsorships' AND column_name = 'total_amount') OR (table_name = 'sponsorship_usages' AND column_name = 'amount_applied'))
-- Preserve every existing major-unit value (100 remains 100). Exact decimal
-- persistence allows currency fractions; application arithmetic converts to
-- integer minor units and new response snapshots explicitly carry their scale.
ALTER TABLE event_pricing ALTER COLUMN base_price TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE event_access ALTER COLUMN price TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE event_access ALTER COLUMN companion_price TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE registrations ALTER COLUMN total_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE registrations ALTER COLUMN paid_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE registrations ALTER COLUMN base_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE registrations ALTER COLUMN discount_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE registrations ALTER COLUMN access_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE registrations ALTER COLUMN sponsorship_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE payment_transaction ALTER COLUMN amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE sponsorships ALTER COLUMN total_amount TYPE DECIMAL(20,4);
--> statement-breakpoint
ALTER TABLE sponsorship_usages ALTER COLUMN amount_applied TYPE DECIMAL(20,4);
