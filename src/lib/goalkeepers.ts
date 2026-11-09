export type GoalkeeperPreference = "FIXED" | "FIELD" | "ANY";

export type GoalkeeperCandidate = {
  userId: string;
  gamesPlayed: number;
  queuePosition: number | null;
  goalkeeperPreference: GoalkeeperPreference;
  lastPlayedAt: Date | null;
};

export type GoalkeeperSource = "FIXED" | "QUEUE" | "TEAM";

export type GoalkeeperAssignment<T extends GoalkeeperCandidate> = {
  goalkeeperA: T | null;
  goalkeeperASource: GoalkeeperSource | null;
  goalkeeperB: T | null;
  goalkeeperBSource: GoalkeeperSource | null;
  sideAFields: T[];
  sideBFields: T[];
  queue: T[];
  remainingFixed: T[];
};

export function byQueueOrder(a: GoalkeeperCandidate, b: GoalkeeperCandidate): number {
  return (
    (a.queuePosition ?? 999) - (b.queuePosition ?? 999) ||
    a.gamesPlayed - b.gamesPlayed ||
    a.userId.localeCompare(b.userId)
  );
}

export function byAnyRotation(a: GoalkeeperCandidate, b: GoalkeeperCandidate): number {
  const aLast = a.lastPlayedAt?.getTime() ?? 0;
  const bLast = b.lastPlayedAt?.getTime() ?? 0;
  return (
    aLast - bLast ||
    a.gamesPlayed - b.gamesPlayed ||
    (a.queuePosition ?? 999) - (b.queuePosition ?? 999) ||
    a.userId.localeCompare(b.userId)
  );
}

export function assignGoalkeepers<T extends GoalkeeperCandidate>(input: {
  sideAFields: T[];
  sideBFields: T[];
  queue: T[];
  fixedGoalkeepers: T[];
}): GoalkeeperAssignment<T> {
  const sideAFields = [...input.sideAFields];
  const sideBFields = [...input.sideBFields];
  const queue = [...input.queue];
  const fixedGoalkeepers = [...input.fixedGoalkeepers];

  const takeFixed = (): T | null => fixedGoalkeepers.shift() ?? null;

  const takeAnyFromQueue = (): T | null => {
    const chosen =
      queue.filter((row) => row.goalkeeperPreference === "ANY").sort(byAnyRotation)[0] ?? null;
    if (!chosen) return null;
    const index = queue.findIndex((row) => row.userId === chosen.userId);
    if (index >= 0) queue.splice(index, 1);
    return chosen;
  };

  const pullTeamAnyWithBackfill = (fields: T[]): T | null => {
    const anyInTeam = fields.filter((row) => row.goalkeeperPreference === "ANY").sort(byAnyRotation)[0];
    if (!anyInTeam) return null;

    const nextLin = queue.filter((row) => row.goalkeeperPreference === "FIELD").sort(byQueueOrder)[0];
    if (!nextLin) return null;

    const linIndex = queue.findIndex((row) => row.userId === nextLin.userId);
    if (linIndex >= 0) queue.splice(linIndex, 1);
    const fieldIndex = fields.findIndex((row) => row.userId === anyInTeam.userId);
    if (fieldIndex >= 0) fields.splice(fieldIndex, 1);
    fields.push(nextLin);
    return anyInTeam;
  };

  const assignForSide = (
    fields: T[],
  ): { row: T; source: GoalkeeperSource } | null => {
    const fixed = takeFixed();
    if (fixed) return { row: fixed, source: "FIXED" };
    const fromQueue = takeAnyFromQueue();
    if (fromQueue) return { row: fromQueue, source: "QUEUE" };
    const fromTeam = pullTeamAnyWithBackfill(fields);
    if (fromTeam) return { row: fromTeam, source: "TEAM" };
    return null;
  };

  const assignmentA = assignForSide(sideAFields);
  const assignmentB = assignForSide(sideBFields);

  return {
    goalkeeperA: assignmentA?.row ?? null,
    goalkeeperASource: assignmentA?.source ?? null,
    goalkeeperB: assignmentB?.row ?? null,
    goalkeeperBSource: assignmentB?.source ?? null,
    sideAFields,
    sideBFields,
    queue,
    remainingFixed: fixedGoalkeepers,
  };
}
