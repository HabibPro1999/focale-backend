function withAffiliation(
  name: string,
  affiliation: string | undefined,
): string {
  const trimmed = affiliation?.trim();
  return trimmed ? `${name} (${trimmed})` : name;
}

export function getAuthorLine(abstract: {
  authorFirstName: string;
  authorLastName: string;
  authorAffiliation: string | null;
  coAuthors: unknown;
}): string {
  const primaryName =
    `${abstract.authorFirstName} ${abstract.authorLastName}`.trim();
  const names = [
    withAffiliation(primaryName, abstract.authorAffiliation ?? undefined),
  ];
  if (Array.isArray(abstract.coAuthors)) {
    for (const coAuthor of abstract.coAuthors) {
      if (
        !coAuthor ||
        typeof coAuthor !== "object" ||
        Array.isArray(coAuthor)
      ) {
        continue;
      }
      const record = coAuthor as Record<string, unknown>;
      const firstName =
        typeof record.firstName === "string" ? record.firstName : "";
      const lastName =
        typeof record.lastName === "string" ? record.lastName : "";
      const affiliation =
        typeof record.affiliation === "string" ? record.affiliation : undefined;
      const fullName = `${firstName} ${lastName}`.trim();
      if (fullName) names.push(withAffiliation(fullName, affiliation));
    }
  }
  return names.filter(Boolean).join(", ");
}
