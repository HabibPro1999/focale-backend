-- Null preserves the historical event networking opt-out policy.
ALTER TABLE registrations ADD COLUMN networking_opt_in boolean;
