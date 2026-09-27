import {
  deriveRegistrationTableColumns,
  findRegistrationFormSchema,
  type DbExecutor,
} from "@app/db";
import type { RegistrationColumnsResponse } from "@app/contracts";

/** The admin grid and report exports share the same stored-form column derivation. */
export async function getRegistrationTableColumns(
  eventId: string,
  db?: DbExecutor,
): Promise<RegistrationColumnsResponse> {
  const form = await findRegistrationFormSchema(eventId, db);
  return deriveRegistrationTableColumns(form?.schema) as RegistrationColumnsResponse;
}
