import { describe, expect, it } from "vitest";
import { nextCapacityLimit } from "@/lib/capacity";

describe("nextCapacityLimit", () => {
  it("não cresce quando há vaga sobrando", () => {
    const result = nextCapacityLimit({ current: 30, reserved: 21 });
    expect(result).toEqual({ ok: true, capacity: 30 });
  });

  it("cresce para reservados + 1 quando está cheio", () => {
    const result = nextCapacityLimit({ current: 30, reserved: 31 });
    expect(result).toEqual({ ok: true, capacity: 31 });
  });

  it("cresce para reservados + 1 quando já está acima do limite", () => {
    const result = nextCapacityLimit({ current: 12, reserved: 21 });
    expect(result).toEqual({ ok: true, capacity: 21 });
  });

  it("não cresce ao readicionar alguém já reservado", () => {
    const result = nextCapacityLimit({ current: 30, reserved: 30 });
    expect(result).toEqual({ ok: true, capacity: 30 });
  });

  it("botão +1 vaga cresce mesmo com vaga sobrando", () => {
    const result = nextCapacityLimit({ current: 30, reserved: 20, extra: 1 });
    expect(result).toEqual({ ok: true, capacity: 31 });
  });

  it("botão +1 vaga sobe acima da lista quando necessário", () => {
    const result = nextCapacityLimit({ current: 20, reserved: 25, extra: 1 });
    expect(result).toEqual({ ok: true, capacity: 26 });
  });

  it("permite chegar exatamente em 200", () => {
    const result = nextCapacityLimit({ current: 199, reserved: 200 });
    expect(result).toEqual({ ok: true, capacity: 200 });
  });

  it("bloqueia quando passa de 200", () => {
    expect(nextCapacityLimit({ current: 200, reserved: 200, extra: 1 })).toEqual({
      ok: false,
      reason: "limit",
    });
    expect(nextCapacityLimit({ current: 12, reserved: 201 })).toEqual({
      ok: false,
      reason: "limit",
    });
  });
});
