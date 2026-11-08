import { describe, expect, it } from "vitest";
import { DrawError, generateTeams, isTeamSize, shuffle, type DrawPlayer } from "@/lib/draw";

function players(count: number): DrawPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Jogador ${index + 1}`,
  }));
}

function seededRandom(seed = 1) {
  let state = seed;
  return (max: number) => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state % max;
  };
}

describe("generateTeams", () => {
  it("forma times completos e deixa as sobras na fila (23 jogadores, 6 por time)", () => {
    const outcome = generateTeams({ players: players(23), teamSize: 6, randomIntFn: seededRandom(7) });

    expect(outcome.teamCount).toBe(3);
    expect(outcome.teams).toHaveLength(3);
    outcome.teams.forEach((team) => expect(team.players).toHaveLength(6));
    expect(outcome.reserves).toHaveLength(5);

    const all = [...outcome.teams.flatMap((team) => team.players), ...outcome.reserves];
    expect(all).toHaveLength(23);
    expect(new Set(all.map((player) => player.id)).size).toBe(23);
  });

  it("não repete jogadores mesmo com entradas duplicadas", () => {
    const input = players(12);
    const outcome = generateTeams({
      players: [...input, ...input.slice(0, 4)],
      teamSize: 6,
      randomIntFn: seededRandom(3),
    });

    const all = outcome.teams.flatMap((team) => team.players.map((player) => player.id));
    expect(new Set(all).size).toBe(all.length);
    expect(outcome.teams).toHaveLength(2);
    expect(outcome.reserves).toHaveLength(0);
  });

  it("coloca os jogadores prioritários nos times", () => {
    const input = players(12);
    const priority = [input[7].id, input[9].id];
    const outcome = generateTeams({
      players: input,
      teamSize: 6,
      prioritize: priority,
      randomIntFn: seededRandom(11),
    });

    const inTeams = new Set(outcome.teams.flatMap((team) => team.players.map((player) => player.id)));
    priority.forEach((id) => expect(inTeams.has(id)).toBe(true));
  });

  it("exige pelo menos dois times completos", () => {
    expect(() => generateTeams({ players: players(7), teamSize: 6 })).toThrow(DrawError);
    expect(() => generateTeams({ players: players(3), teamSize: 6 })).toThrow(/pelo menos 12/);
  });

  it("valida tamanho do time", () => {
    expect(() => generateTeams({ players: players(20), teamSize: 5 })).toThrow(/6 a 11/);
    expect(isTeamSize(5)).toBe(false);
    expect(isTeamSize(6)).toBe(true);
    expect(isTeamSize(11)).toBe(true);
    expect(isTeamSize(12)).toBe(false);
  });

  it("produz combinações diferentes com sementes diferentes", () => {
    const first = generateTeams({ players: players(18), teamSize: 6, randomIntFn: seededRandom(1) });
    const second = generateTeams({ players: players(18), teamSize: 6, randomIntFn: seededRandom(99) });

    const firstOrder = first.teams.flatMap((team) => team.players.map((player) => player.id)).join(",");
    const secondOrder = second.teams.flatMap((team) => team.players.map((player) => player.id)).join(",");
    expect(firstOrder).not.toBe(secondOrder);
  });
});

describe("shuffle", () => {
  it("preserva os elementos e não usa a mesma referência de array", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = shuffle(input, seededRandom(5));
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...output].sort((a, b) => a - b)).toEqual(input);
  });
});
