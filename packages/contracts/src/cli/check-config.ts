// Operator pre-deploy check (read-only): validates THIS process's environment
// with the production rules and prints which keys fail. It prints key names
// and rule text only, never values, and connects to nothing.
//
//   node packages/contracts/dist/cli/check-config.js   (Render shell / image)
//   pnpm config:check                                  (repo, after pnpm build)
//
// Exit code: 0 when every rule passes, 1 otherwise.
import { checkProductionConfig, formatProductionConfigReport } from "../config-check";

const report = checkProductionConfig(process.env);
const output = formatProductionConfigReport(report);
if (report.ok) {
  console.log(output);
} else {
  console.error(output);
  process.exitCode = 1;
}
