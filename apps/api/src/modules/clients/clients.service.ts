import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ErrorCodes,
  DEFAULT_ENABLED_MODULES,
  normalizeEnabledModules,
  type CreateClientInput,
  type UpdateClientInput,
  type ListClientsQuery,
} from "@app/contracts";
import {
  insertClient,
  getClientById,
  updateClientRow,
  listClientsPage,
  deleteClientRow,
  getClientDeletionInfo,
  type ClientRow,
  type UpdateClientData,
} from "@app/db";
import { getSkip, paginate, type PaginatedResult } from "@app/shared";
import { invalidateUserCacheForClient } from "../../core/auth/user-cache";

@Injectable()
export class ClientsService {
  /** Create a client. Optional fields coerce undefined -> null; modules default to all. */
  async create(input: CreateClientInput): Promise<ClientRow> {
    const { name, logo, primaryColor, email, phone, enabledModules } = input;
    return insertClient({
      name,
      logo: logo ?? null,
      primaryColor: primaryColor ?? null,
      email: email ?? null,
      phone: phone ?? null,
      enabledModules: enabledModules ?? [...DEFAULT_ENABLED_MODULES],
    });
  }

  /** Fetch a client by id, or null. */
  getById(id: string): Promise<ClientRow | null> {
    return getClientById(id);
  }

  /**
   * Update a client. enabledModules is replacement semantics: omitted ⇒ column
   * left untouched; [] ⇒ persisted as empty (all modules off). Always evicts the
   * auth cache for this client's users, regardless of which fields changed.
   */
  async update(id: string, input: UpdateClientInput): Promise<ClientRow> {
    // Defense-in-depth: reachable when called outside the HTTP layer (Zod's
    // refine already blocks empty bodies at the route).
    if (Object.values(input).every((value) => value === undefined)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: "At least one field must be provided for update",
      });
    }

    const existing = await getClientById(id);
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Client not found",
      });
    }

    const { enabledModules, ...restInput } = input;
    const nextEnabledModules =
      enabledModules === undefined
        ? undefined
        : normalizeEnabledModules(enabledModules);

    const data: UpdateClientData = {
      ...restInput,
      ...(nextEnabledModules !== undefined && {
        enabledModules: nextEnabledModules,
      }),
    };

    const updated = await updateClientRow(id, data);
    await invalidateUserCacheForClient(id);
    return updated;
  }

  /** List clients with pagination + optional active/search filters (createdAt desc). */
  async list(query: ListClientsQuery): Promise<PaginatedResult<ClientRow>> {
    const { page, limit, active, search } = query;
    const skip = getSkip({ page, limit });
    const { data, total } = await listClientsPage({
      skip,
      limit,
      active,
      search,
    });
    return paginate(data, total, { page, limit });
  }

  /** Hard-delete a client. Blocked (409) while it still has users or events. */
  async remove(id: string): Promise<void> {
    const info = await getClientDeletionInfo(id);
    if (!info) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Client not found",
      });
    }
    if (info.userCount > 0 || info.eventCount > 0) {
      throw new ConflictException({
        code: ErrorCodes.CLIENT_HAS_DEPENDENCIES,
        message: `Cannot delete client with ${info.userCount} user(s) and ${info.eventCount} event(s). Remove associated data first.`,
      });
    }
    await deleteClientRow(id);
  }
}
