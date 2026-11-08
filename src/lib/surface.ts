export type EventSurface = "GRASS" | "SOCIETY" | "FUTSAL" | "SAND";

export const SURFACE_LABELS: Record<EventSurface, string> = {
  GRASS: "Campo",
  SOCIETY: "Society",
  FUTSAL: "Futsal",
  SAND: "Areia",
};

export function surfaceLabel(value: string | null | undefined): string | null {
  if (value === "GRASS" || value === "SOCIETY" || value === "FUTSAL" || value === "SAND") {
    return SURFACE_LABELS[value];
  }
  return null;
}

export function surfaceCover(value: string | null | undefined): string {
  if (value === "SAND") return "/covers/beach.jpg";
  return "/covers/court.jpg";
}
