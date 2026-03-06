import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  role: z.number(),
  clientId: z.string().nullable(),
  active: z.boolean(),
}).strict();

export type UserResponse = z.infer<typeof UserSchema>;
