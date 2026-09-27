import { canAccessClient } from "../auth/user-cache";
import { forbidden, notFound } from "../app-exception";

type TenantUser = Parameters<typeof canAccessClient>[0];

/** Load → missing resource → ownership, and nothing else. Callers keep their
 * original loader, owner field, exception class and later policy checks. */
export async function assertOwned<T>(
  user: TenantUser,
  load: () => Promise<T | null | undefined>,
  clientId: (resource: T) => string,
  errors: { notFound: string; forbidden?: () => Error },
): Promise<T> {
  const resource = await load();
  if (resource === null || resource === undefined) throw notFound(errors.notFound);
  if (!canAccessClient(user, clientId(resource))) {
    if (errors.forbidden) throw errors.forbidden();
    forbidden();
  }
  return resource;
}
