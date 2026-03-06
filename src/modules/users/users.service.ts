import { UserSchema, type UserResponse } from "./users.schema.js";

export function formatUserResponse(user: {
  id: string;
  email: string;
  name: string;
  role: number;
  clientId: string | null;
  active: boolean;
}): UserResponse {
  return UserSchema.parse(user);
}
