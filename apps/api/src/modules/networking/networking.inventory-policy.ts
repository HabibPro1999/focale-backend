/** An exhibitor has one independent visitor station per representative, not one whole-stand lock. */
export function networkingInventoryResource(
  table: {
    id: string;
    kind: "TABLE" | "STAND";
    ownerProfileId?: string | null;
  },
  participants: Array<{ id: string; standTableId?: string | null }>,
) {
  if (table.kind === "TABLE") return `table:${table.id}`;
  const representatives = participants.filter(
    (profile) =>
      profile.standTableId === table.id || table.ownerProfileId === profile.id,
  );
  return representatives.length === 1
    ? `stand:${table.id}:profile:${representatives[0].id}`
    : null;
}
