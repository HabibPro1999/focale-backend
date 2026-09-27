type AccessQuantity = { accessId: string; quantity: number };

export function quantitiesByAccess(items: AccessQuantity[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    quantities.set(item.accessId, (quantities.get(item.accessId) ?? 0) + item.quantity);
  }
  return quantities;
}

/** Old keys first, then new keys: this order determines capacity-error precedence. */
export function quantityDeltas(oldQuantities: Map<string, number>, newQuantities: Map<string, number>) {
  return Array.from(new Set([...oldQuantities.keys(), ...newQuantities.keys()]))
    .map((accessId) => ({
      accessId,
      delta: (newQuantities.get(accessId) ?? 0) - (oldQuantities.get(accessId) ?? 0),
    }))
    .filter(({ delta }) => delta !== 0);
}
