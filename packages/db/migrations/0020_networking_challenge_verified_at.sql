-- migrate: transaction per-file
-- Marks the one successful attempt on a challenge so summed failed OTP attempts exclude it.
ALTER TABLE networking_challenges ADD COLUMN verified_at TIMESTAMPTZ(3);
