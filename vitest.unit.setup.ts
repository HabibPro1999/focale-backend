// Unit tests must never inherit a developer or CI database URL. Real database
// tiers use their own setup files and validate their disposable test URL.
process.env.DATABASE_URL =
  "postgresql://test_user:test_password@localhost:5432/focale_unit_test";
