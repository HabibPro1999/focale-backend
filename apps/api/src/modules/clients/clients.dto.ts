import {
  CreateClientSchema,
  UpdateClientSchema,
  ListClientsQuerySchema,
  ClientIdParamSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CreateClientDto extends createZodDto(CreateClientSchema) {}
export class UpdateClientDto extends createZodDto(UpdateClientSchema) {}
export class ListClientsQueryDto extends createZodDto(ListClientsQuerySchema) {}
export class ClientIdParamDto extends createZodDto(ClientIdParamSchema) {}
