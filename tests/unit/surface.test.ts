import { describe, expect, it } from "vitest";
import { surfaceCover, surfaceLabel } from "@/lib/surface";

describe("piso do evento", () => {
  it("traduz os pisos de futebol", () => {
    expect(surfaceLabel("GRASS")).toBe("Campo");
    expect(surfaceLabel("SOCIETY")).toBe("Society");
    expect(surfaceLabel("FUTSAL")).toBe("Futsal");
    expect(surfaceLabel("SAND")).toBe("Areia");
    expect(surfaceLabel(null)).toBeNull();
  });

  it("escolhe a capa padrão", () => {
    expect(surfaceCover("SAND")).toBe("/covers/beach.jpg");
    expect(surfaceCover("GRASS")).toBe("/covers/court.jpg");
    expect(surfaceCover(null)).toBe("/covers/court.jpg");
  });
});
