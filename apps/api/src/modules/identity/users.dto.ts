import {
  CreateUserSchema,
  ListUsersQuerySchema,
  UpdateUserSchema,
  UserIdParamSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CreateUserDto extends createZodDto(CreateUserSchema) {}
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
export class ListUsersQueryDto extends createZodDto(ListUsersQuerySchema) {}
export class UserIdParamDto extends createZodDto(UserIdParamSchema) {}
