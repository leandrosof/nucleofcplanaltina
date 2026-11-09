import { describe, expect, it } from "vitest";
import { assignGoalkeepers, type GoalkeeperCandidate } from "@/lib/goalkeepers";

function person(
  userId: string,
  goalkeeperPreference: "FIXED" | "FIELD" | "ANY",
  options: Partial<Omit<GoalkeeperCandidate, "userId" | "goalkeeperPreference">> = {},
): GoalkeeperCandidate {
  return {
    userId,
    goalkeeperPreference,
    gamesPlayed: options.gamesPlayed ?? 0,
    queuePosition: options.queuePosition ?? null,
    lastPlayedAt: options.lastPlayedAt ?? null,
  };
}

function fields(count: number, prefix = "f"): GoalkeeperCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    person(`${prefix}${index + 1}`, "FIELD", { queuePosition: index + 1 }),
  );
}

describe("assignGoalkeepers", () => {
  it("usa goleiros fixos primeiro e deixa o terceiro na reserva", () => {
    const fixed = [
      person("gk1", "FIXED"),
      person("gk2", "FIXED"),
      person("gk3", "FIXED"),
    ];
    const result = assignGoalkeepers({
      sideAFields: fields(6, "a"),
      sideBFields: fields(6, "b"),
      queue: [],
      fixedGoalkeepers: fixed,
    });

    expect(result.goalkeeperA?.userId).toBe("gk1");
    expect(result.goalkeeperASource).toBe("FIXED");
    expect(result.goalkeeperB?.userId).toBe("gk2");
    expect(result.goalkeeperBSource).toBe("FIXED");
    expect(result.remainingFixed.map((row) => row.userId)).toEqual(["gk3"]);
  });

  it("usa GL da fila quando não há goleiro fixo", () => {
    const any = person("any1", "ANY", { queuePosition: 1 });
    const lin = person("lin1", "FIELD", { queuePosition: 2 });
    const result = assignGoalkeepers({
      sideAFields: fields(6, "a"),
      sideBFields: fields(6, "b"),
      queue: [any, lin],
      fixedGoalkeepers: [],
    });

    expect(result.goalkeeperA?.userId).toBe("any1");
    expect(result.goalkeeperASource).toBe("QUEUE");
    expect(result.queue.map((row) => row.userId)).toEqual(["lin1"]);
  });

  it("puxa GL do time e completa a linha com o próximo LIN da fila", () => {
    const teamAny = person("teamany", "ANY");
    const queueLin = person("queuelin", "FIELD", { queuePosition: 1 });
    const sideA = [...fields(5, "a"), teamAny];
    const result = assignGoalkeepers({
      sideAFields: sideA,
      sideBFields: fields(6, "b"),
      queue: [queueLin],
      fixedGoalkeepers: [],
    });

    expect(result.goalkeeperA?.userId).toBe("teamany");
    expect(result.goalkeeperASource).toBe("TEAM");
    expect(result.sideAFields).toHaveLength(6);
    expect(result.sideAFields.map((row) => row.userId)).toContain("queuelin");
    expect(result.queue).toHaveLength(0);
  });

  it("não puxa GL do time sem LIN na fila", () => {
    const teamAny = person("teamany", "ANY");
    const result = assignGoalkeepers({
      sideAFields: [...fields(5, "a"), teamAny],
      sideBFields: fields(6, "b"),
      queue: [],
      fixedGoalkeepers: [],
    });

    expect(result.goalkeeperA).toBeNull();
    expect(result.goalkeeperASource).toBeNull();
    expect(result.sideAFields.some((row) => row.userId === "teamany")).toBe(true);
  });

  it("não usa GL de outro time como goleiro", () => {
    const teamBAny = person("teambany", "ANY");
    const result = assignGoalkeepers({
      sideAFields: fields(6, "a"),
      sideBFields: [...fields(5, "b"), teamBAny],
      queue: [person("lin", "FIELD", { queuePosition: 1 })],
      fixedGoalkeepers: [],
    });

    expect(result.goalkeeperA).toBeNull();
    expect(result.goalkeeperASource).toBeNull();
    expect(result.goalkeeperB?.userId).toBe("teambany");
    expect(result.goalkeeperBSource).toBe("TEAM");
  });

  it("faz rodízio entre GL da fila pelo último jogo", () => {
    const older = person("older", "ANY", {
      queuePosition: 1,
      lastPlayedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = person("newer", "ANY", {
      queuePosition: 2,
      lastPlayedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const result = assignGoalkeepers({
      sideAFields: fields(6, "a"),
      sideBFields: fields(6, "b"),
      queue: [older, newer],
      fixedGoalkeepers: [],
    });

    expect(result.goalkeeperA?.userId).toBe("older");
  });

  it("prioriza fixo mesmo com GL na fila", () => {
    const result = assignGoalkeepers({
      sideAFields: fields(6, "a"),
      sideBFields: fields(6, "b"),
      queue: [person("any", "ANY", { queuePosition: 1 })],
      fixedGoalkeepers: [person("gk", "FIXED")],
    });

    expect(result.goalkeeperA?.userId).toBe("gk");
    expect(result.goalkeeperASource).toBe("FIXED");
    expect(result.goalkeeperB?.userId).toBe("any");
    expect(result.goalkeeperBSource).toBe("QUEUE");
  });
});
