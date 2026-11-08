import { describe, expect, it } from "vitest";
import { readableTextColor, TEAM_PALETTE, TEAM_SIZE_OPTIONS, teamVisualForIndex } from "@/lib/teams";

describe("paleta de times", () => {
  it("tem apenas azul e vermelho", () => {
    expect(TEAM_PALETTE).toHaveLength(2);
    expect(TEAM_PALETTE.map((item) => item.name)).toEqual(["Azul", "Vermelho"]);
    expect(TEAM_PALETTE.map((item) => item.color)).toEqual(["blue", "red"]);
  });

  it("nomeia os times como Time N alternando as cores", () => {
    expect(teamVisualForIndex(0)).toMatchObject({ name: "Time 1", color: "blue" });
    expect(teamVisualForIndex(1)).toMatchObject({ name: "Time 2", color: "red" });
    expect(teamVisualForIndex(2)).toMatchObject({ name: "Time 3", color: "blue" });
    expect(teamVisualForIndex(3)).toMatchObject({ name: "Time 4", color: "red" });
  });

  it("permite times de 6 a 11 jogadores", () => {
    expect(TEAM_SIZE_OPTIONS).toEqual([6, 7, 8, 9, 10, 11]);
  });
});

describe("readableTextColor", () => {
  it("usa texto claro em cores escuras", () => {
    expect(readableTextColor("#1f2937")).toBe("#f8fafc");
    expect(readableTextColor("#000080")).toBe("#f8fafc");
    expect(readableTextColor("#6b7280")).toBe("#f8fafc");
  });

  it("usa texto escuro em cores claras", () => {
    expect(readableTextColor("#e5e7eb")).toBe("#0b1220");
    expect(readableTextColor("#ffdb58")).toBe("#0b1220");
    expect(readableTextColor("#7fffd4")).toBe("#0b1220");
  });
});
