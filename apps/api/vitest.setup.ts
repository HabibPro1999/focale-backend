// Set a valid base env before any app module parses config (fail-fast schema).
// Mirrors the legacy tests/helpers/test-env.ts loadUnitEnv: force NODE_ENV=test
// and a dummy DATABASE_URL (unit/e2e tests never connect), supply the minimal
// firebase-storage vars the schema refines require.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgresql://test_user:test_password@localhost:5432/focale_unit_test";
process.env.CORS_ORIGIN ??= "http://localhost:8080";
process.env.STORAGE_PROVIDER ??= "firebase";
process.env.FIREBASE_PROJECT_ID ??= "test-project";
process.env.FIREBASE_STORAGE_BUCKET ??= "test-bucket";
