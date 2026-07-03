import { dbTestsEnabled, loadMigrationEnv } from "./helpers/test-env";

// The migration tier owns its scratch DB lifecycle, so setup only runs the gate.
if (dbTestsEnabled()) {
  loadMigrationEnv();
}
