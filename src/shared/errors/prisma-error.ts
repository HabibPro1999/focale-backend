import { Prisma } from "@/generated/prisma/client.js";

export interface PrismaUniqueTarget {
  fields: string[];
  names: string[];
}

export function getPrismaUniqueTarget(
  error: Prisma.PrismaClientKnownRequestError,
): PrismaUniqueTarget {
  const fields: string[] = [];
  const names: string[] = [];
  const target = error.meta?.target;

  if (Array.isArray(target)) {
    fields.push(
      ...target.filter((field): field is string => typeof field === "string"),
    );
  } else if (typeof target === "string") {
    names.push(target);
  }

  const adapterConstraint = (
    error.meta?.driverAdapterError as
      | { cause?: { constraint?: { fields?: unknown; name?: unknown } } }
      | undefined
  )?.cause?.constraint;

  if (Array.isArray(adapterConstraint?.fields)) {
    fields.push(
      ...adapterConstraint.fields.filter(
        (field): field is string => typeof field === "string",
      ),
    );
  }
  if (typeof adapterConstraint?.name === "string") {
    names.push(adapterConstraint.name);
  }

  return { fields, names };
}
