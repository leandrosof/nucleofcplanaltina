export const MAX_CAPACITY = 200;

export type CapacityResult =
  | { ok: true; capacity: number }
  | { ok: false; reason: "limit" };

export function nextCapacityLimit(input: {
  current: number;
  reserved: number;
  extra?: number;
}): CapacityResult {
  const desired = Math.max(input.current, input.reserved) + (input.extra ?? 0);
  if (desired > MAX_CAPACITY) return { ok: false, reason: "limit" };
  return { ok: true, capacity: desired };
}
