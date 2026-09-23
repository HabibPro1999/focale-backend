import { dbTestsEnabled } from "./helpers/test-env";

// Fail closed if the opt-in is present without a safe admin URL.
dbTestsEnabled();
