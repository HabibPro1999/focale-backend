import { dbTestsEnabled } from "@app/db/testing";

// Fail closed if the opt-in is present without a safe admin URL.
dbTestsEnabled();
