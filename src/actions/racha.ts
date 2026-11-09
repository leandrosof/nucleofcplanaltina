"use server";

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import {
  attendances,
  drawTeams,
  draws,
  events,
  gamePlayers,
  gameSubstitutions,
  games,
  rotationCourts,
  users,
} from "@/db/schema";
import {
  AppError,
  actionFailure,
  fail,
  firstZodMessage,
  success,
  type ActionState,
} from "@/lib/action";
import { recordAudit } from "@/lib/audit";
import {
  planFirstMatch,
  planNextMatch,
  type RachaPlayer,
  type RachaRule,
} from "@/lib/racha";
import { shuffle } from "@/lib/draw";
import { assignGoalkeepers } from "@/lib/goalkeepers";
import { getSessionUser } from "@/lib/session";
import { teamVisualForIndex } from "@/lib/teams";
import {
  eventIdSchema,
  finalizeMatchSchema,
  gameIdSchema,
  rachaAddPlayerSchema,
  rachaAttendanceSchema,
  rachaCourtSchema,
  rachaGoalkeeperSchema,
  rachaQueueModeSchema,
  rachaQueueSwapSchema,
  rachaSessionSchema,
  rachaStartSchema,
  rachaSubstitutionSchema,
  rachaTeamSizeSchema,
} from "@/lib/validations";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type PresentRow = {
  userId: string;
  gamesPlayed: number;
  queuePosition: number | null;
  queueTeamId: string | null;
  rotationStatus: "IDLE" | "WAITING" | "PLAYING" | "LEFT" | "PAUSED";
  goalkeeperPreference: "FIXED" | "FIELD" | "ANY";
  lastPlayedAt: Date | null;
};

function toRachaPlayers(rows: PresentRow[]): RachaPlayer[] {
  return rows.map((row) => ({
    userId: row.userId,
    gamesPlayed: row.gamesPlayed,
    queuePosition: row.queuePosition ?? 0,
    blockId: row.queueTeamId,
  }));
}

function toRule(value: string): RachaRule {
  if (
    value === "WINNER_STAYS" ||
    value === "ROTATE_ALL" ||
    value === "ARRIVAL_QUEUE"
  ) {
    return value;
  }
  return "HYBRID";
}

async function loadPresent(tx: Tx, eventId: string): Promise<PresentRow[]> {
  return tx
    .select({
      userId: attendances.userId,
      gamesPlayed: attendances.gamesPlayed,
      queuePosition: attendances.queuePosition,
      queueTeamId: attendances.queueTeamId,
      rotationStatus: attendances.rotationStatus,
      goalkeeperPreference: sql<"FIXED" | "FIELD" | "ANY">`coalesce(${attendances.goalkeeperPreference}, ${users.goalkeeperPreference})`,
      lastPlayedAt: attendances.lastPlayedAt,
    })
    .from(attendances)
    .innerJoin(users, eq(users.id, attendances.userId))
    .where(
      and(
        eq(attendances.eventId, eventId),
        eq(attendances.status, "CONFIRMED"),
        eq(attendances.isOrganizer, false),
        isNotNull(attendances.checkedInAt),
        ne(attendances.rotationStatus, "LEFT"),
        eq(users.active, true),
      ),
    )
    .orderBy(asc(attendances.queuePosition), asc(attendances.createdAt));
}

async function applyLineup(
  tx: Tx,
  eventId: string,
  sideA: string[],
  sideB: string[],
  queue: string[],
  blocks?: Map<string, string | null>,
): Promise<void> {
  const playing = [...sideA, ...sideB];
  for (const userId of playing) {
    await tx
      .update(attendances)
      .set({
        rotationStatus: "PLAYING",
        queuePosition: null,
        queueTeamId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, userId)));
  }
  for (let index = 0; index < queue.length; index += 1) {
    await tx
      .update(attendances)
      .set({
        rotationStatus: "WAITING",
        queuePosition: index + 1,
        queueTeamId: blocks?.get(queue[index]) ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, queue[index])));
  }
}

async function appendPlayersToQueue(
  tx: Tx,
  eventId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const [maxRow] = await tx
    .select({ position: sql<number>`max(${attendances.queuePosition})` })
    .from(attendances)
    .where(eq(attendances.eventId, eventId));
  let position = Number(maxRow?.position ?? 0);
  for (const userId of [...new Set(userIds)]) {
    position += 1;
    await tx
      .update(attendances)
      .set({
        rotationStatus: "WAITING",
        queuePosition: position,
        queueTeamId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, userId)));
  }
}

async function dissolvePartialBlocks(
  tx: Tx,
  eventId: string,
  teamSize: number,
): Promise<void> {
  await tx.execute(sql`
    with blocks as (
      select queue_team_id, count(*) as total
      from attendances
      where event_id = ${eventId}
        and rotation_status = 'WAITING'
        and is_organizer = false
        and queue_team_id is not null
      group by queue_team_id
    )
    update attendances a
    set queue_team_id = null, updated_at = now()
    from blocks
    where a.event_id = ${eventId}
      and a.queue_team_id = blocks.queue_team_id
      and blocks.total < ${teamSize}
  `);
}
async function renumberQueue(tx: Tx, eventId: string): Promise<void> {
  await tx.execute(sql`
    with ranked as (
      select id, row_number() over (
        order by queue_position nulls last, created_at asc, id asc
      ) as rn
      from attendances
      where event_id = ${eventId}
        and rotation_status = 'WAITING'
        and is_organizer = false
    )
    update attendances a
    set queue_position = ranked.rn, updated_at = now()
    from ranked
    where a.id = ranked.id
  `);
}
async function normalizeOrphanPlayers(
  tx: Tx,
  drawId: string,
  eventId: string,
): Promise<void> {
  const activeRows = await tx
    .select({ userId: gamePlayers.userId })
    .from(gamePlayers)
    .innerJoin(games, eq(games.id, gamePlayers.gameId))
    .where(
      and(
        eq(games.drawId, drawId),
        sql`${games.status} in ('IN_PROGRESS', 'NOT_STARTED')`,
        isNull(gamePlayers.leftAt),
      ),
    );
  const active = new Set(activeRows.map((row) => row.userId));

  const playing = await tx
    .select({ userId: attendances.userId })
    .from(attendances)
    .where(
      and(
        eq(attendances.eventId, eventId),
        eq(attendances.rotationStatus, "PLAYING"),
        eq(attendances.isOrganizer, false),
      ),
    );
  const orphans = playing
    .map((row) => row.userId)
    .filter((userId) => !active.has(userId));
  await appendPlayersToQueue(tx, eventId, orphans);
}
async function createSession(
  tx: Tx,
  eventId: string,
  teamSize: number,
  courtCount: number,
  queueModeValue: "KEEP_TEAM" | "MIX",
  actorId: string,
) {
  await tx
    .update(attendances)
    .set({
      rotationStatus: "WAITING",
      queuePosition: null,
      queueTeamId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(attendances.eventId, eventId),
        eq(attendances.status, "CONFIRMED"),
        eq(attendances.isOrganizer, false),
        isNotNull(attendances.checkedInAt),
        ne(attendances.rotationStatus, "LEFT"),
      ),
    );

  const present = await loadPresent(tx, eventId);
  const ordered = present
    .slice()
    .sort((a, b) => a.gamesPlayed - b.gamesPlayed || (a.queuePosition ?? 0) - (b.queuePosition ?? 0));

  for (let index = 0; index < ordered.length; index += 1) {
    await tx
      .update(attendances)
      .set({
        queuePosition: index + 1,
        rotationStatus: "WAITING",
        queueTeamId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, ordered[index].userId)));
  }

  const [draw] = await tx
    .insert(draws)
    .values({
      eventId,
      teamSize,
      courtCount,
      queueMode: queueModeValue,
      status: "IN_PROGRESS",
      createdById: actorId,
      lockedAt: new Date(),
    })
    .returning();

  const neededField = teamSize * 2 * courtCount;
  const fieldPool = ordered.filter((row) => row.goalkeeperPreference !== "FIXED");
  const fixedPool = ordered.filter((row) => row.goalkeeperPreference === "FIXED");

  while (fieldPool.length < neededField && fixedPool.length > 0) {
    fieldPool.push(fixedPool.shift()!);
  }

  if (fieldPool.length < neededField) {
    throw new AppError(
      `Marque a chegada de mais ${neededField - fieldPool.length} jogador(es) de linha para abrir ${courtCount} quadra(s) de ${teamSize} + goleiro.`,
    );
  }

  const teamCount = Math.floor(fieldPool.length / teamSize);
  if (teamCount < courtCount * 2) {
    throw new AppError(
      `São necessários ${courtCount * 2} times completos de ${teamSize} jogadores de linha com chegada marcada para abrir ${courtCount} quadra(s).`,
    );
  }

  const teams: { id: string; players: PresentRow[] }[] = [];
  for (let index = 0; index < teamCount; index += 1) {
    const visual = teamVisualForIndex(index);
    const [team] = await tx
      .insert(drawTeams)
      .values({
        drawId: draw.id,
        name: visual.name,
        color: visual.color,
        sortOrder: index,
      })
      .returning({ id: drawTeams.id });
    teams.push({
      id: team.id,
      players: fieldPool.slice(index * teamSize, (index + 1) * teamSize),
    });
  }

  let availableFixed = [...fixedPool];
  let reserveFields = [
    ...teams.slice(courtCount * 2).flatMap((team) => team.players),
    ...fieldPool.slice(teamCount * teamSize),
  ];

  for (let court = 1; court <= courtCount; court += 1) {
    const teamAIndex = (court - 1) * 2;
    const teamBIndex = teamAIndex + 1;
    const teamA = teams[teamAIndex];
    const teamB = teams[teamBIndex];

    const assignment = assignGoalkeepers({
      sideAFields: teamA.players,
      sideBFields: teamB.players,
      queue: reserveFields,
      fixedGoalkeepers: availableFixed,
    });
    availableFixed = assignment.remainingFixed;
    reserveFields = assignment.queue;
    teams[teamAIndex].players = assignment.sideAFields;
    teams[teamBIndex].players = assignment.sideBFields;

    const goalkeeperA = assignment.goalkeeperA;
    const goalkeeperB = assignment.goalkeeperB;
    const courtPlayersA = [
      ...assignment.sideAFields,
      ...(goalkeeperA ? [goalkeeperA] : []),
    ];
    const courtPlayersB = [
      ...assignment.sideBFields,
      ...(goalkeeperB ? [goalkeeperB] : []),
    ];
    const preservedQueue = new Map<string, number>();
    if (
      assignment.goalkeeperASource === "QUEUE" &&
      goalkeeperA?.queuePosition != null
    ) {
      preservedQueue.set(goalkeeperA.userId, goalkeeperA.queuePosition);
    }
    if (
      assignment.goalkeeperBSource === "QUEUE" &&
      goalkeeperB?.queuePosition != null
    ) {
      preservedQueue.set(goalkeeperB.userId, goalkeeperB.queuePosition);
    }

    const [game] = await tx
      .insert(games)
      .values({
        drawId: draw.id,
        eventId,
        teamAId: teamA.id,
        teamBId: teamB.id,
        status: "NOT_STARTED",
        source: "RACHA",
        court,
        sequence: court,
        createdById: actorId,
      })
      .returning({ id: games.id });

    await tx.insert(gamePlayers).values([
      ...assignment.sideAFields.map((row) => ({
        gameId: game.id,
        teamId: teamA.id,
        userId: row.userId,
        position: "FIELD" as const,
      })),
      ...assignment.sideBFields.map((row) => ({
        gameId: game.id,
        teamId: teamB.id,
        userId: row.userId,
        position: "FIELD" as const,
      })),
      ...(goalkeeperA
        ? [{
            gameId: game.id,
            teamId: teamA.id,
            userId: goalkeeperA.userId,
            role: assignment.goalkeeperASource === "TEAM" ? ("STARTER" as const) : ("SUB" as const),
            position: "GOALKEEPER" as const,
          }]
        : []),
      ...(goalkeeperB
        ? [{
            gameId: game.id,
            teamId: teamB.id,
            userId: goalkeeperB.userId,
            role: assignment.goalkeeperBSource === "TEAM" ? ("STARTER" as const) : ("SUB" as const),
            position: "GOALKEEPER" as const,
          }]
        : []),
    ]);

    await tx.insert(rotationCourts).values({
      sessionId: draw.id,
      number: court,
      status: "PLAYING",
      teamAId: teamA.id,
      teamBId: teamB.id,
      playerAIds: courtPlayersA.map((row) => row.userId),
      playerBIds: courtPlayersB.map((row) => row.userId),
      currentGameId: game.id,
    });

    for (const row of [...courtPlayersA, ...courtPlayersB]) {
      await tx
        .update(attendances)
        .set({
          rotationStatus: "PLAYING",
          queuePosition: preservedQueue.get(row.userId) ?? null,
          queueTeamId: null,
          updatedAt: new Date(),
        })
        .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, row.userId)));
    }
  }

  let position = 0;
  const reserveTeams = teams.slice(courtCount * 2);
  for (const team of reserveTeams) {
    const block = reserveFields.splice(0, teamSize);
    if (block.length === 0) continue;
    for (const row of block) {
      position += 1;
      await tx
        .update(attendances)
        .set({
          rotationStatus: "WAITING",
          queuePosition: position,
          queueTeamId: queueModeValue === "KEEP_TEAM" ? team.id : null,
          updatedAt: new Date(),
        })
        .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, row.userId)));
    }
  }

  for (const row of reserveFields) {
    position += 1;
    await tx
      .update(attendances)
      .set({
        rotationStatus: "WAITING",
        queuePosition: position,
        queueTeamId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, row.userId)));
  }

  for (const row of availableFixed) {
    position += 1;
    await tx
      .update(attendances)
      .set({
        rotationStatus: "WAITING",
        queuePosition: position,
        queueTeamId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(attendances.eventId, eventId), eq(attendances.userId, row.userId)));
  }

  return { draw };
}

async function mountNextForCourt(
  tx: Tx,
  draw: typeof draws.$inferSelect,
  eventId: string,
  court: number,
): Promise<string | null> {
  const [existing] = await tx
    .select({ id: games.id })
    .from(games)
    .where(
      and(
        eq(games.drawId, draw.id),
        eq(games.court, court),
        sql`${games.status} in ('IN_PROGRESS', 'NOT_STARTED')`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [courtRow] = await tx
    .select()
    .from(rotationCourts)
    .where(and(eq(rotationCourts.sessionId, draw.id), eq(rotationCourts.number, court)))
    .limit(1);
  if (!courtRow) return null;

  const waiting = (await loadPresent(tx, eventId)).filter(
    (row) => row.rotationStatus === "WAITING",
  );
  const fixedGoalkeepers = waiting
    .filter((row) => row.goalkeeperPreference === "FIXED")
    .sort(
      (a, b) =>
        a.gamesPlayed - b.gamesPlayed ||
        (a.queuePosition ?? 999) - (b.queuePosition ?? 999),
    );
  const fieldPlayers = waiting.filter((row) => row.goalkeeperPreference !== "FIXED");
  const plan = planFirstMatch(toRachaPlayers(fieldPlayers), draw.teamSize, "HYBRID");
  if (!plan.ok) return null;

  const fieldById = new Map(fieldPlayers.map((row) => [row.userId, row]));
  const sideAFields = plan.sideA
    .map((userId) => fieldById.get(userId))
    .filter((row): row is PresentRow => Boolean(row));
  const sideBFields = plan.sideB
    .map((userId) => fieldById.get(userId))
    .filter((row): row is PresentRow => Boolean(row));
  const queueFields = plan.queue
    .map((userId) => fieldById.get(userId))
    .filter((row): row is PresentRow => Boolean(row));

  const assignment = assignGoalkeepers({
    sideAFields,
    sideBFields,
    queue: queueFields,
    fixedGoalkeepers,
  });
  const goalkeeperA = assignment.goalkeeperA?.userId ?? null;
  const goalkeeperB = assignment.goalkeeperB?.userId ?? null;
  const sideAFieldIds = assignment.sideAFields.map((row) => row.userId);
  const sideBFieldIds = assignment.sideBFields.map((row) => row.userId);
  const sideA = [...sideAFieldIds, ...(goalkeeperA ? [goalkeeperA] : [])];
  const sideB = [...sideBFieldIds, ...(goalkeeperB ? [goalkeeperB] : [])];
  const queue = [
    ...assignment.queue.map((row) => row.userId),
    ...assignment.remainingFixed.map((row) => row.userId),
  ];

  const [teamCountRow] = await tx
    .select({ total: sql<number>`count(*)` })
    .from(drawTeams)
    .where(eq(drawTeams.drawId, draw.id));
  const base = Number(teamCountRow?.total ?? 0);

  const visualA = teamVisualForIndex(base);
  const visualB = teamVisualForIndex(base + 1);
  const [teamA] = await tx
    .insert(drawTeams)
    .values({ drawId: draw.id, name: visualA.name, color: visualA.color, sortOrder: base })
    .returning({ id: drawTeams.id });
  const [teamB] = await tx
    .insert(drawTeams)
    .values({ drawId: draw.id, name: visualB.name, color: visualB.color, sortOrder: base + 1 })
    .returning({ id: drawTeams.id });

  const [sequenceRow] = await tx
    .select({ sequence: sql<number>`max(${games.sequence})` })
    .from(games)
    .where(eq(games.drawId, draw.id));
  const sequence = Number(sequenceRow?.sequence ?? 0) + 1;

  const [game] = await tx
    .insert(games)
    .values({
      drawId: draw.id,
      eventId,
      teamAId: teamA.id,
      teamBId: teamB.id,
      status: "NOT_STARTED",
      source: "RACHA",
      court,
      sequence,
      createdById: draw.createdById,
    })
    .returning({ id: games.id });

  await tx.insert(gamePlayers).values([
    ...sideAFieldIds.map((userId) => ({
      gameId: game.id,
      teamId: teamA.id,
      userId,
      position: "FIELD" as const,
    })),
    ...sideBFieldIds.map((userId) => ({
      gameId: game.id,
      teamId: teamB.id,
      userId,
      position: "FIELD" as const,
    })),
    ...(goalkeeperA
      ? [{
          gameId: game.id,
          teamId: teamA.id,
          userId: goalkeeperA,
          role: assignment.goalkeeperASource === "TEAM" ? ("STARTER" as const) : ("SUB" as const),
          position: "GOALKEEPER" as const,
        }]
      : []),
    ...(goalkeeperB
      ? [{
          gameId: game.id,
          teamId: teamB.id,
          userId: goalkeeperB,
          role: assignment.goalkeeperBSource === "TEAM" ? ("STARTER" as const) : ("SUB" as const),
          position: "GOALKEEPER" as const,
        }]
      : []),
  ]);

  await tx
    .update(rotationCourts)
    .set({
      status: "PLAYING",
      teamAId: teamA.id,
      teamBId: teamB.id,
      playerAIds: sideA,
      playerBIds: sideB,
      currentGameId: game.id,
      updatedAt: new Date(),
    })
    .where(eq(rotationCourts.id, courtRow.id));

  await applyLineup(tx, eventId, sideA, sideB, queue);

  if (assignment.goalkeeperASource === "QUEUE" && assignment.goalkeeperA?.queuePosition != null) {
    await tx
      .update(attendances)
      .set({ queuePosition: assignment.goalkeeperA.queuePosition, updatedAt: new Date() })
      .where(
        and(eq(attendances.eventId, eventId), eq(attendances.userId, goalkeeperA!)),
      );
  }
  if (assignment.goalkeeperBSource === "QUEUE" && assignment.goalkeeperB?.queuePosition != null) {
    await tx
      .update(attendances)
      .set({ queuePosition: assignment.goalkeeperB.queuePosition, updatedAt: new Date() })
      .where(
        and(eq(attendances.eventId, eventId), eq(attendances.userId, goalkeeperB!)),
      );
  }
  return game.id;
}

async function tryMountAnyCourt(
  tx: Tx,
  draw: typeof draws.$inferSelect,
  eventId: string,
): Promise<void> {
  const rows = await tx
    .select({ number: rotationCourts.number })
    .from(rotationCourts)
    .where(and(eq(rotationCourts.sessionId, draw.id), eq(rotationCourts.status, "EMPTY")))
    .orderBy(asc(rotationCourts.number));
  for (const row of rows) {
    const mounted = await mountNextForCourt(tx, draw, eventId, row.number);
    if (mounted) return;
  }
}

async function findQueueCandidate(
  tx: Tx,
  eventId: string,
  exclude: Set<string>,
): Promise<{ userId: string; name: string } | null> {
  const rows = await tx
    .select({ userId: users.id, name: users.name })
    .from(attendances)
    .innerJoin(users, eq(users.id, attendances.userId))
    .where(
      and(
        eq(attendances.eventId, eventId),
        eq(attendances.status, "CONFIRMED"),
        eq(attendances.rotationStatus, "WAITING"),
        isNotNull(attendances.checkedInAt),
        eq(users.active, true),
      ),
    )
    .orderBy(asc(attendances.gamesPlayed), asc(attendances.queuePosition), asc(attendances.createdAt));

  return rows.find((row) => !exclude.has(row.userId)) ?? null;
}

export async function startRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaStartSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(eq(events.id, parsed.data.eventId))
        .for("update")
        .limit(1);
      if (!event) throw new AppError("Evento não encontrado.");

      const [active] = await tx
        .select({ id: draws.id })
        .from(draws)
        .where(and(eq(draws.eventId, event.id), eq(draws.status, "IN_PROGRESS")))
        .limit(1);
      if (active) throw new AppError("Já existe um racha em andamento neste evento.");

      await createSession(tx, event.id, parsed.data.teamSize, parsed.data.courtCount, "KEEP_TEAM", actor.id);
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.start",
      entity: "event",
      entityId: parsed.data.eventId,
      details: { teamSize: parsed.data.teamSize },
    });

    revalidatePath("/", "layout");
    return success("Racha iniciado. A primeira partida está pronta.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function addToRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaAddPlayerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(eq(events.id, parsed.data.eventId))
        .for("update")
        .limit(1);
      if (!event) throw new AppError("Evento não encontrado.");

      const [maxRow] = await tx
        .select({ position: sql<number>`max(${attendances.queuePosition})` })
        .from(attendances)
        .where(eq(attendances.eventId, event.id));

      const [existing] = await tx
        .select()
        .from(attendances)
        .where(
          and(
            eq(attendances.eventId, event.id),
            eq(attendances.userId, parsed.data.userId),
          ),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(attendances)
          .set({
            status: "CONFIRMED",
            isOrganizer: false,
            checkedInAt: new Date(),
            rotationStatus: "WAITING",
            queuePosition: Number(maxRow?.position ?? 0) + 1,
            queueTeamId: null,
            leftAt: null,
            updatedAt: new Date(),
          })
          .where(eq(attendances.id, existing.id));
      } else {
        await tx.insert(attendances).values({
          eventId: event.id,
          userId: parsed.data.userId,
          status: "CONFIRMED",
          checkedInAt: new Date(),
          rotationStatus: "WAITING",
          queuePosition: Number(maxRow?.position ?? 0) + 1,
        });
      }

      const [draw] = await tx
        .select()
        .from(draws)
        .where(and(eq(draws.eventId, event.id), eq(draws.status, "IN_PROGRESS")))
        .orderBy(desc(draws.createdAt))
        .limit(1);
      if (draw) await tryMountAnyCourt(tx, draw, event.id);
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.add_player",
      entity: "event",
      entityId: parsed.data.eventId,
      details: { userId: parsed.data.userId },
    });

    revalidatePath("/", "layout");
    return success("Jogador adicionado à lista e à fila.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function checkInRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaAttendanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor) return fail("Faça login para continuar.");

  try {
    const joinedQueue = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(attendances)
        .where(eq(attendances.id, parsed.data.attendanceId))
        .for("update")
        .limit(1);
      if (!row) throw new AppError("Presença não encontrada.");
      if (actor.role !== "ADMIN" && row.userId !== actor.id) {
        throw new AppError("Você só pode marcar a sua própria chegada.");
      }
      if (row.status !== "CONFIRMED") {
        throw new AppError("Confirme presença antes de marcar a chegada.");
      }
      if (row.checkedInAt && row.rotationStatus !== "LEFT") return false;

      const [draw] = await tx
        .select()
        .from(draws)
        .where(and(eq(draws.eventId, row.eventId), eq(draws.status, "IN_PROGRESS")))
        .orderBy(desc(draws.createdAt))
        .limit(1);

      if (!draw) {
        await tx
          .update(attendances)
          .set({
            checkedInAt: new Date(),
            rotationStatus: "IDLE",
            queuePosition: null,
            queueTeamId: null,
            leftAt: null,
            updatedAt: new Date(),
          })
          .where(eq(attendances.id, row.id));
        return false;
      }

      const [maxRow] = await tx
        .select({ position: sql<number>`max(${attendances.queuePosition})` })
        .from(attendances)
        .where(eq(attendances.eventId, row.eventId));

      await tx
        .update(attendances)
        .set({
          checkedInAt: new Date(),
          rotationStatus: "WAITING",
          queuePosition: Number(maxRow?.position ?? 0) + 1,
          leftAt: null,
          updatedAt: new Date(),
        })
        .where(eq(attendances.id, row.id));

      await tryMountAnyCourt(tx, draw, row.eventId);
      return true;
    });

    revalidatePath("/", "layout");
    return success(
      joinedQueue ? "Chegada registrada. Você entrou na fila." : "Chegada registrada.",
    );
  } catch (error) {
    return actionFailure(error);
  }
}

export async function undoCheckInAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaAttendanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor) return fail("Faça login para continuar.");

  try {
    const message = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(attendances)
        .where(eq(attendances.id, parsed.data.attendanceId))
        .for("update")
        .limit(1);
      if (!row) throw new AppError("Presença não encontrada.");
      if (actor.role !== "ADMIN" && row.userId !== actor.id) {
        throw new AppError("Você só pode desfazer a sua própria chegada.");
      }

      const [draw] = await tx
        .select()
        .from(draws)
        .where(and(eq(draws.eventId, row.eventId), eq(draws.status, "IN_PROGRESS")))
        .orderBy(desc(draws.createdAt))
        .limit(1);

      const removalMessage = draw ? await removeFromRacha(tx, row, actor.id) : null;

      await tx
        .update(attendances)
        .set({
          checkedInAt: null,
          rotationStatus: "IDLE",
          queuePosition: null,
          queueTeamId: null,
          leftAt: null,
          updatedAt: new Date(),
        })
        .where(eq(attendances.id, row.id));

      return removalMessage && removalMessage !== "Jogador já estava fora."
        ? `${removalMessage} Chegada desfeita.`
        : "Chegada desfeita.";
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.undo_check_in",
      entity: "attendance",
      entityId: parsed.data.attendanceId,
    });

    revalidatePath("/", "layout");
    return success(message);
  } catch (error) {
    return actionFailure(error);
  }
}

export async function startMatchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = gameIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [initial] = await tx
        .select({ drawId: games.drawId })
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .limit(1);
      if (!initial) throw new AppError("Partida não encontrada.");

      await tx.select().from(draws).where(eq(draws.id, initial.drawId)).for("update").limit(1);

      const [game] = await tx
        .select()
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .for("update")
        .limit(1);
      if (!game) throw new AppError("Partida não encontrada.");
      if (game.status !== "NOT_STARTED") throw new AppError("Esta partida não está pronta para iniciar.");

      const [live] = await tx
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.drawId, game.drawId), eq(games.court, game.court), eq(games.status, "IN_PROGRESS")))
        .limit(1);
      if (live) throw new AppError("Já existe uma partida em andamento.");

      const roster = await tx
        .select({ teamId: gamePlayers.teamId, position: gamePlayers.position })
        .from(gamePlayers)
        .where(and(eq(gamePlayers.gameId, game.id), isNull(gamePlayers.leftAt)));
      const fieldA = roster.filter(
        (row) => row.teamId === game.teamAId && row.position === "FIELD",
      ).length;
      const fieldB = roster.filter(
        (row) => row.teamId === game.teamBId && row.position === "FIELD",
      ).length;
      const goalkeeperA = roster.filter(
        (row) => row.teamId === game.teamAId && row.position === "GOALKEEPER",
      ).length;
      const goalkeeperB = roster.filter(
        (row) => row.teamId === game.teamBId && row.position === "GOALKEEPER",
      ).length;
      if (
        fieldA === 0 ||
        fieldB === 0 ||
        Math.abs(fieldA - fieldB) > 1
      ) {
        throw new AppError("Os times precisam ter no máximo 1 jogador de linha de diferença.");
      }
      if (goalkeeperA !== 1 || goalkeeperB !== 1) {
        throw new AppError("Defina um goleiro para cada time antes de iniciar a partida.");
      }

      await tx
        .update(games)
        .set({ status: "IN_PROGRESS", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(games.id, game.id));
    });

    revalidatePath("/", "layout");
    return success("Partida iniciada.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function finalizeMatchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = finalizeMatchSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    const message = await db.transaction(async (tx) => {
      const [initial] = await tx
        .select({ drawId: games.drawId, eventId: games.eventId })
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .limit(1);
      if (!initial) throw new AppError("Partida não encontrada.");

      const [draw] = await tx
        .select()
        .from(draws)
        .where(eq(draws.id, initial.drawId))
        .for("update")
        .limit(1);
      if (!draw) throw new AppError("Sessão não encontrada.");

      const [game] = await tx
        .select()
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .for("update")
        .limit(1);
      if (!game) throw new AppError("Partida não encontrada.");
      if (game.status !== "IN_PROGRESS") throw new AppError("Esta partida não está em andamento.");

      const roster = await tx
        .select({
          userId: gamePlayers.userId,
          teamId: gamePlayers.teamId,
          position: gamePlayers.position,
          role: gamePlayers.role,
          replacedUserId: gamePlayers.replacedUserId,
          goalkeeperPreference: sql<"FIXED" | "FIELD" | "ANY">`coalesce(${attendances.goalkeeperPreference}, ${users.goalkeeperPreference})`,
        })
        .from(gamePlayers)
        .innerJoin(users, eq(users.id, gamePlayers.userId))
        .leftJoin(
          attendances,
          and(
            eq(attendances.eventId, game.eventId),
            eq(attendances.userId, gamePlayers.userId),
          ),
        )
        .where(and(eq(gamePlayers.gameId, game.id), isNull(gamePlayers.leftAt)));
      const fieldA = roster
        .filter((row) => row.teamId === game.teamAId && row.position === "FIELD")
        .map((row) => row.userId);
      const fieldB = roster
        .filter((row) => row.teamId === game.teamBId && row.position === "FIELD")
        .map((row) => row.userId);
      const currentGoalkeeperRows = roster.filter((row) => row.position === "GOALKEEPER");
      const extraTempGoalkeepers = currentGoalkeeperRows
        .filter(
          (row) =>
            row.goalkeeperPreference !== "FIXED" &&
            row.role === "SUB" &&
            row.replacedUserId === null,
        )
        .map((row) => row.userId);
      const fixedExtraGoalkeepers = currentGoalkeeperRows
        .filter(
          (row) => row.goalkeeperPreference === "FIXED" && row.role === "SUB" && row.replacedUserId === null,
        )
        .map((row) => row.userId);
      const teamGoalkeepers = currentGoalkeeperRows
        .filter((row) => !extraTempGoalkeepers.includes(row.userId) && !fixedExtraGoalkeepers.includes(row.userId))
        .map((row) => row.userId);
      if (
        fieldA.length === 0 ||
        fieldB.length === 0 ||
        Math.abs(fieldA.length - fieldB.length) > 1
      ) {
        throw new AppError("Há jogador de linha faltando. Substitua antes de finalizar a partida.");
      }

      const teamSize = draw.teamSize;
      const isDraw = game.scoreA === game.scoreB;
      if (isDraw && !parsed.data.stayingSide) {
        throw new AppError("Empate! Escolha qual time permanece para a próxima partida.");
      }

      const winnerSide: "A" | "B" = isDraw
        ? (parsed.data.stayingSide as "A" | "B")
        : game.scoreA > game.scoreB
          ? "A"
          : "B";
      const winnerTeamId = isDraw
        ? null
        : winnerSide === "A"
          ? game.teamAId
          : game.teamBId;
      const rotationWinnerTeamId = winnerSide === "A" ? game.teamAId : game.teamBId;
      const otherTeamId = winnerSide === "A" ? game.teamBId : game.teamAId;
      const winnerIds = winnerSide === "A" ? fieldA : fieldB;
      const loserIds = winnerSide === "A" ? fieldB : fieldA;

      const snapshot = await tx
        .select({
          userId: attendances.userId,
          rotationStatus: attendances.rotationStatus,
          queuePosition: attendances.queuePosition,
          queueTeamId: attendances.queueTeamId,
          gamesPlayed: attendances.gamesPlayed,
          lastPlayedAt: attendances.lastPlayedAt,
        })
        .from(attendances)
        .where(eq(attendances.eventId, game.eventId));

      await tx
        .update(games)
        .set({
          status: "FINISHED",
          winnerTeamId,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(games.id, game.id));

      for (const userId of [
        ...winnerIds,
        ...loserIds,
        ...teamGoalkeepers,
        ...fixedExtraGoalkeepers,
      ]) {
        await tx
          .update(attendances)
          .set({
            gamesPlayed: sql`${attendances.gamesPlayed} + 1`,
            lastPlayedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(attendances.eventId, game.eventId), eq(attendances.userId, userId)));
      }

      for (const userId of extraTempGoalkeepers) {
        await tx
          .update(attendances)
          .set({ lastPlayedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(attendances.eventId, game.eventId), eq(attendances.userId, userId)));
      }

      const [event] = await tx.select().from(events).where(eq(events.id, game.eventId)).limit(1);
      const rule = toRule(event?.rotationRule ?? "HYBRID");
      const keepTeam = draw.queueMode === "KEEP_TEAM";
      await dissolvePartialBlocks(tx, game.eventId, teamSize);
      const present = await loadPresent(tx, game.eventId);
      const extraTempSet = new Set(extraTempGoalkeepers);
      const teamGoalkeeperSet = new Set(teamGoalkeepers);
      const maxQueuePosition = Math.max(
        0,
        ...present
          .filter((row) => row.rotationStatus === "WAITING")
          .map((row) => row.queuePosition ?? 0),
      );
      let teamGoalkeeperOffset = 0;
      const planPlayers = present.filter((row) => {
        if (row.goalkeeperPreference === "FIXED") return false;
        if (extraTempSet.has(row.userId) || teamGoalkeeperSet.has(row.userId)) return true;
        return (
          row.rotationStatus === "WAITING" ||
          winnerIds.includes(row.userId) ||
          loserIds.includes(row.userId)
        );
      });
      const playersForPlan = planPlayers.map((row) => {
        let queuePosition = row.queuePosition ?? 0;
        if (extraTempSet.has(row.userId)) {
          queuePosition = (row.queuePosition ?? maxQueuePosition + 1) - 0.5;
        } else if (teamGoalkeeperSet.has(row.userId)) {
          teamGoalkeeperOffset += 1;
          queuePosition = maxQueuePosition + teamGoalkeeperOffset;
        }
        return {
          userId: row.userId,
          gamesPlayed: row.gamesPlayed,
          queuePosition,
          blockId: loserIds.includes(row.userId)
            ? keepTeam
              ? otherTeamId
              : null
            : row.queueTeamId,
        };
      });
      const plan = planNextMatch({
        rule,
        teamSize,
        players: playersForPlan,
        winnerIds,
        loserIds,
        stayingSide: isDraw ? (parsed.data.stayingSide as "A" | "B") : undefined,
        sideAIds: fieldA,
        sideBIds: fieldB,
      });

      if (!plan.ok) {
        const ordered = present
          .filter(
            (row) =>
              row.rotationStatus === "WAITING" ||
              winnerIds.includes(row.userId) ||
              loserIds.includes(row.userId) ||
              currentGoalkeeperRows.some((gk) => gk.userId === row.userId),
          )
          .sort(
            (a, b) =>
              a.gamesPlayed - b.gamesPlayed ||
              (a.queuePosition ?? 0) - (b.queuePosition ?? 0),
          );
        for (let index = 0; index < ordered.length; index += 1) {
          await tx
            .update(attendances)
            .set({
              rotationStatus: "WAITING",
              queuePosition: index + 1,
              queueTeamId: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(attendances.eventId, game.eventId),
                eq(attendances.userId, ordered[index].userId),
              ),
            );
        }
        await tx
          .update(rotationCourts)
          .set({
            status: "EMPTY",
            teamAId: null,
            teamBId: null,
            playerAIds: null,
            playerBIds: null,
            currentGameId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(rotationCourts.sessionId, draw.id),
              eq(rotationCourts.number, game.court),
            ),
          );
        await tx
          .update(games)
          .set({ undoState: { attendances: snapshot, nextGameId: null } })
          .where(eq(games.id, game.id));
        await renumberQueue(tx, game.eventId);
        return `Partida finalizada. Faltam ${plan.missing} jogador(es) para montar o próximo jogo.`;
      }

      await tx
        .update(games)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(games.drawId, draw.id),
            eq(games.court, game.court),
            eq(games.status, "IN_PROGRESS"),
            ne(games.id, game.id),
          ),
        );
      await tx
        .delete(games)
        .where(
          and(
            eq(games.drawId, draw.id),
            eq(games.court, game.court),
            eq(games.status, "NOT_STARTED"),
          ),
        );

      const [sequenceRow] = await tx
        .select({ sequence: sql<number>`max(${games.sequence})` })
        .from(games)
        .where(eq(games.drawId, draw.id));
      const sequence = Number(sequenceRow?.sequence ?? 0) + 1;

      let opponentTeamId: string | null = null;
      if (plan.winnerStayed) {
        const opponentRows = await tx
          .select({ queueTeamId: attendances.queueTeamId })
          .from(attendances)
          .where(and(eq(attendances.eventId, game.eventId), inArray(attendances.userId, plan.sideB)));
        const blocks = new Set(
          opponentRows
            .map((row) => row.queueTeamId)
            .filter((value): value is string => Boolean(value)),
        );
        if (
          blocks.size === 1 &&
          opponentRows.every((row) => row.queueTeamId === [...blocks][0])
        ) {
          opponentTeamId = [...blocks][0];
        } else {
          const [countRow] = await tx
            .select({ total: sql<number>`count(*)` })
            .from(drawTeams)
            .where(eq(drawTeams.drawId, draw.id));
          const base = Number(countRow?.total ?? 0);
          const visual = teamVisualForIndex(base);
          const [team] = await tx
            .insert(drawTeams)
            .values({
              drawId: draw.id,
              name: visual.name,
              color: visual.color,
              sortOrder: base,
            })
            .returning({ id: drawTeams.id });
          opponentTeamId = team.id;
        }
      }

      const nextTeamAId = plan.winnerStayed ? rotationWinnerTeamId : game.teamAId;
      const nextTeamBId = plan.winnerStayed ? opponentTeamId! : game.teamBId;

      const [next] = await tx
        .insert(games)
        .values({
          drawId: draw.id,
          eventId: game.eventId,
          teamAId: nextTeamAId,
          teamBId: nextTeamBId,
          status: "NOT_STARTED",
          source: "RACHA",
          court: game.court,
          sequence,
          createdById: actor.id,
        })
        .returning({ id: games.id });

      const presentById = new Map(present.map((row) => [row.userId, row]));
      const fixedGoalkeepers = present
        .filter(
          (row) =>
            row.goalkeeperPreference === "FIXED" && row.rotationStatus !== "LEFT",
        )
        .sort(
          (a, b) =>
            a.gamesPlayed - b.gamesPlayed ||
            (a.queuePosition ?? 999) - (b.queuePosition ?? 999),
        );
      const sideAFieldRows = plan.sideA
        .map((userId) => presentById.get(userId))
        .filter((row): row is PresentRow => Boolean(row));
      const sideBFieldRows = plan.sideB
        .map((userId) => presentById.get(userId))
        .filter((row): row is PresentRow => Boolean(row));
      const queueRows = plan.queue
        .map((userId) => presentById.get(userId))
        .filter((row): row is PresentRow => Boolean(row));
      const assignment = assignGoalkeepers({
        sideAFields: sideAFieldRows,
        sideBFields: sideBFieldRows,
        queue: queueRows,
        fixedGoalkeepers,
      });
      const goalkeeperA = assignment.goalkeeperA;
      const goalkeeperB = assignment.goalkeeperB;
      const sideAFieldIds = assignment.sideAFields.map((row) => row.userId);
      const sideBFieldIds = assignment.sideBFields.map((row) => row.userId);
      const nextQueueRows = [...assignment.queue, ...assignment.remainingFixed];
      const nextQueue = nextQueueRows.map((row) => row.userId);
      const sideAPlaying = [
        ...sideAFieldIds,
        ...(goalkeeperA ? [goalkeeperA.userId] : []),
      ];
      const sideBPlaying = [
        ...sideBFieldIds,
        ...(goalkeeperB ? [goalkeeperB.userId] : []),
      ];
      const preservedNextQueue = new Map<string, number>();
      if (
        assignment.goalkeeperASource === "QUEUE" &&
        goalkeeperA?.queuePosition != null
      ) {
        preservedNextQueue.set(goalkeeperA.userId, goalkeeperA.queuePosition);
      }
      if (
        assignment.goalkeeperBSource === "QUEUE" &&
        goalkeeperB?.queuePosition != null
      ) {
        preservedNextQueue.set(goalkeeperB.userId, goalkeeperB.queuePosition);
      }

      await tx.insert(gamePlayers).values([
        ...sideAFieldIds.map((userId) => ({
          gameId: next.id,
          teamId: nextTeamAId,
          userId,
          position: "FIELD" as const,
        })),
        ...sideBFieldIds.map((userId) => ({
          gameId: next.id,
          teamId: nextTeamBId,
          userId,
          position: "FIELD" as const,
        })),
        ...(goalkeeperA
          ? [{
              gameId: next.id,
              teamId: nextTeamAId,
              userId: goalkeeperA.userId,
              role: assignment.goalkeeperASource === "TEAM" ? ("STARTER" as const) : ("SUB" as const),
              position: "GOALKEEPER" as const,
            }]
          : []),
        ...(goalkeeperB
          ? [{
              gameId: next.id,
              teamId: nextTeamBId,
              userId: goalkeeperB.userId,
              role: assignment.goalkeeperBSource === "TEAM" ? ("STARTER" as const) : ("SUB" as const),
              position: "GOALKEEPER" as const,
            }]
          : []),
      ]);

      const blocks = new Map<string, string | null>();
      for (const row of nextQueueRows) {
        blocks.set(row.userId, row.queueTeamId ?? null);
      }
      for (const loserId of loserIds) {
        if (nextQueue.includes(loserId)) {
          blocks.set(loserId, keepTeam ? otherTeamId : null);
        }
      }

      await tx
        .update(rotationCourts)
        .set({
          status: "PLAYING",
          teamAId: nextTeamAId,
          teamBId: nextTeamBId,
          playerAIds: sideAPlaying,
          playerBIds: sideBPlaying,
          currentGameId: next.id,
          updatedAt: new Date(),
        })
        .where(
          and(eq(rotationCourts.sessionId, draw.id), eq(rotationCourts.number, game.court)),
        );

      await applyLineup(tx, game.eventId, sideAPlaying, sideBPlaying, nextQueue, blocks);
      await renumberQueue(tx, game.eventId);

      for (const [userId, queuePosition] of preservedNextQueue) {
        await tx
          .update(attendances)
          .set({ queuePosition, updatedAt: new Date() })
          .where(
            and(eq(attendances.eventId, game.eventId), eq(attendances.userId, userId)),
          );
      }

      await tx
        .update(games)
        .set({ undoState: { attendances: snapshot, nextGameId: next.id } })
        .where(eq(games.id, game.id));

      return "Partida finalizada. O próximo confronto já está montado.";
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.finalize",
      entity: "game",
      entityId: parsed.data.gameId,
    });

    revalidatePath("/", "layout");
    return success(message);
  } catch (error) {
    return actionFailure(error);
  }
}

export async function undoRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [draw] = await tx
        .select()
        .from(draws)
        .where(eq(draws.id, parsed.data.drawId))
        .for("update")
        .limit(1);
      if (!draw) throw new AppError("Sessão não encontrada.");

      const [last] = await tx
        .select()
        .from(games)
        .where(and(eq(games.drawId, draw.id), eq(games.status, "FINISHED")))
        .orderBy(desc(games.sequence))
        .limit(1);
      if (!last) throw new AppError("Não há partida finalizada para desfazer.");

      const undo = last.undoState as
        | {
            attendances?: {
              userId: string;
              rotationStatus: "IDLE" | "WAITING" | "PLAYING" | "LEFT" | "PAUSED";
              queuePosition: number | null;
              queueTeamId: string | null;
              gamesPlayed: number;
              lastPlayedAt: Date | string | null;
            }[];
            nextGameId?: string | null;
          }
        | null;
      if (!undo?.attendances) throw new AppError("Esta partida não pode ser desfeita.");

      if (undo.nextGameId) {
        const [next] = await tx
          .select()
          .from(games)
          .where(eq(games.id, undo.nextGameId))
          .limit(1);
        if (next) {
          if (next.status !== "NOT_STARTED") {
            throw new AppError("A próxima partida já começou. Encerre-a antes de desfazer.");
          }
          await tx.delete(games).where(eq(games.id, next.id));
        }
      }

      await tx
        .update(games)
        .set({
          status: "IN_PROGRESS",
          winnerTeamId: null,
          finishedAt: null,
          undoState: null,
          updatedAt: new Date(),
        })
        .where(eq(games.id, last.id));

      for (const row of undo.attendances) {
        await tx
          .update(attendances)
          .set({
            rotationStatus: row.rotationStatus,
            queuePosition: row.queuePosition,
            queueTeamId: row.queueTeamId,
            gamesPlayed: row.gamesPlayed,
            lastPlayedAt: row.lastPlayedAt ? new Date(row.lastPlayedAt) : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(attendances.eventId, draw.eventId),
              eq(attendances.userId, row.userId),
            ),
          );
      }
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.undo",
      entity: "draw",
      entityId: parsed.data.drawId,
    });

    revalidatePath("/", "layout");
    return success("Último resultado desfeito.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function substitutePlayerAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaSubstitutionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    const message = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .for("update")
        .limit(1);
      if (!game) throw new AppError("Partida não encontrada.");
      if (game.status !== "IN_PROGRESS" && game.status !== "NOT_STARTED") {
        throw new AppError("Só é possível substituir na partida atual ou na próxima.");
      }

      await tx.select().from(draws).where(eq(draws.id, game.drawId)).for("update").limit(1);

      const [outRow] = await tx
        .select()
        .from(gamePlayers)
        .where(
          and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.userId, parsed.data.outUserId)),
        )
        .limit(1);
      if (!outRow) throw new AppError("O jogador não está nesta partida.");
      const [alreadySubstituted] = await tx
        .select({ id: gameSubstitutions.id })
        .from(gameSubstitutions)
        .where(
          and(
            eq(gameSubstitutions.gameId, game.id),
            eq(gameSubstitutions.outUserId, outRow.userId),
          ),
        )
        .limit(1);
      if (alreadySubstituted) throw new AppError("Este jogador já foi substituído.");

      const current = await tx
        .select({ userId: gamePlayers.userId })
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, game.id));
      const exclude = new Set(current.map((row) => row.userId));

      const candidate = parsed.data.inUserId
        ? (
            await tx
              .select({ userId: users.id, name: users.name })
              .from(attendances)
              .innerJoin(users, eq(users.id, attendances.userId))
              .where(
                and(
                  eq(attendances.eventId, game.eventId),
                  eq(attendances.userId, parsed.data.inUserId),
                  eq(attendances.status, "CONFIRMED"),
                ),
              )
              .limit(1)
          )[0] ?? null
        : await findQueueCandidate(tx, game.eventId, exclude);
      if (!candidate) {
        throw new AppError("Não há jogador na fila. A partida fica pausada até alguém entrar.");
      }
      if (exclude.has(candidate.userId)) throw new AppError("Este jogador já está na partida.");

      const [inRow] = await tx
        .select()
        .from(attendances)
        .where(
          and(eq(attendances.eventId, game.eventId), eq(attendances.userId, candidate.userId)),
        )
        .limit(1);
      if (!inRow || inRow.rotationStatus === "LEFT" || inRow.status !== "CONFIRMED") {
        throw new AppError("O substituto precisa estar confirmado e presente.");
      }

      if (game.status === "IN_PROGRESS") {
        await tx
          .update(gamePlayers)
          .set({ leftAt: new Date() })
          .where(eq(gamePlayers.id, outRow.id));
      } else {
        await tx.delete(gamePlayers).where(eq(gamePlayers.id, outRow.id));
      }

      await tx.insert(gamePlayers).values({
        gameId: game.id,
        teamId: outRow.teamId,
        userId: candidate.userId,
        role: "SUB",
        position: outRow.position,
        temporaryGoalkeeper: outRow.temporaryGoalkeeper,
        replacedUserId: outRow.userId,
      });

      await tx
        .update(attendances)
        .set({ rotationStatus: "LEFT", queuePosition: null, leftAt: new Date(), updatedAt: new Date() })
        .where(and(eq(attendances.eventId, game.eventId), eq(attendances.userId, outRow.userId)));
      await tx
        .update(attendances)
        .set({
        rotationStatus: "PLAYING",
        queuePosition: null,
        queueTeamId: null,
        updatedAt: new Date(),
      })
        .where(
          and(eq(attendances.eventId, game.eventId), eq(attendances.userId, candidate.userId)),
        );

      await tx.insert(gameSubstitutions).values({
        gameId: game.id,
        teamId: outRow.teamId,
        outUserId: outRow.userId,
        inUserId: candidate.userId,
        createdById: actor.id,
      });

      return `${candidate.name} entrou no lugar de outro jogador.`;
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.substitute",
      entity: "game",
      entityId: parsed.data.gameId,
      details: { outUserId: parsed.data.outUserId },
    });

    revalidatePath("/", "layout");
    return success(`Substituição registrada. ${message}`);
  } catch (error) {
    return actionFailure(error);
  }
}

async function removeFromRacha(
  tx: Tx,
  row: typeof attendances.$inferSelect,
  actorId: string,
): Promise<string> {
  if (row.rotationStatus === "LEFT") return "Jogador já estava fora.";

  const [draw] = await tx
    .select()
    .from(draws)
    .where(and(eq(draws.eventId, row.eventId), eq(draws.status, "IN_PROGRESS")))
    .orderBy(desc(draws.createdAt))
    .limit(1);

  const [game] = draw
    ? await tx
        .select()
        .from(games)
        .where(
          and(
            eq(games.drawId, draw.id),
            sql`${games.status} in ('IN_PROGRESS', 'NOT_STARTED')`,
          ),
        )
        .orderBy(desc(games.sequence))
        .limit(1)
    : [];

  const [playerRow] = game
    ? await tx
        .select()
        .from(gamePlayers)
        .where(
          and(
            eq(gamePlayers.gameId, game.id),
            eq(gamePlayers.userId, row.userId),
            isNull(gamePlayers.leftAt),
          ),
        )
        .limit(1)
    : [];

  if (game && playerRow) {
    await tx
      .update(attendances)
      .set({ rotationStatus: "LEFT", queuePosition: null, leftAt: new Date(), updatedAt: new Date() })
      .where(eq(attendances.id, row.id));

    const exclude = new Set(
      (
        await tx
          .select({ userId: gamePlayers.userId })
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, game.id))
      ).map((item) => item.userId),
    );
    const candidate = await findQueueCandidate(tx, row.eventId, exclude);

    if (candidate) {
      await tx.insert(gamePlayers).values({
        gameId: game.id,
        teamId: playerRow.teamId,
        userId: candidate.userId,
        role: "SUB",
        position: playerRow.position,
        temporaryGoalkeeper: playerRow.temporaryGoalkeeper,
        replacedUserId: row.userId,
      });
      await tx
        .update(gamePlayers)
        .set({ leftAt: new Date() })
        .where(eq(gamePlayers.id, playerRow.id));
      await tx
        .update(attendances)
        .set({
          rotationStatus: "PLAYING",
          queueTeamId: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(attendances.eventId, row.eventId), eq(attendances.userId, candidate.userId)),
        );
      await tx.insert(gameSubstitutions).values({
        gameId: game.id,
        teamId: playerRow.teamId,
        outUserId: row.userId,
        inUserId: candidate.userId,
        createdById: actorId,
        reason: "Saída do racha",
      });
      return "Jogador removido e substituído pelo próximo da fila.";
    }

    if (game.status === "NOT_STARTED") {
      await tx.delete(games).where(eq(games.id, game.id));
      if (draw) await tryMountAnyCourt(tx, draw, row.eventId);
    }
    return "Jogador removido. A partida fica pausada até entrar um substituto.";
  }

  await tx
    .update(attendances)
    .set({ rotationStatus: "LEFT", queuePosition: null, leftAt: new Date(), updatedAt: new Date() })
    .where(eq(attendances.id, row.id));

  const waiting = await tx
    .select({ id: attendances.id })
    .from(attendances)
    .where(
      and(
        eq(attendances.eventId, row.eventId),
        eq(attendances.rotationStatus, "WAITING"),
      ),
    )
    .orderBy(asc(attendances.queuePosition), asc(attendances.createdAt));
  for (let index = 0; index < waiting.length; index += 1) {
    await tx
      .update(attendances)
      .set({ queuePosition: index + 1, updatedAt: new Date() })
      .where(eq(attendances.id, waiting[index].id));
  }

  return "Jogador removido da fila.";
}

export async function leaveRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaAttendanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor) return fail("Faça login para continuar.");

  try {
    const message = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(attendances)
        .where(eq(attendances.id, parsed.data.attendanceId))
        .for("update")
        .limit(1);
      if (!row) throw new AppError("Presença não encontrada.");
      if (actor.role !== "ADMIN" && row.userId !== actor.id) {
        throw new AppError("Você só pode alterar a sua própria presença.");
      }
      return removeFromRacha(tx, row, actor.id);
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.leave",
      entity: "attendance",
      entityId: parsed.data.attendanceId,
    });

    revalidatePath("/", "layout");
    return success(message);
  } catch (error) {
    return actionFailure(error);
  }
}

export async function restartRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(draws)
        .where(eq(draws.id, parsed.data.drawId))
        .for("update")
        .limit(1);
      if (!current) throw new AppError("Sessão não encontrada.");

      const [live] = await tx
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.drawId, current.id), eq(games.status, "IN_PROGRESS")))
        .limit(1);
      if (live) {
        await tx
          .update(games)
          .set({ status: "CANCELLED", updatedAt: new Date() })
          .where(and(eq(games.drawId, current.id), eq(games.status, "IN_PROGRESS")));
      }

      await tx
        .update(draws)
        .set({ status: "FINISHED", finishedAt: new Date() })
        .where(eq(draws.id, current.id));
      await tx
        .delete(games)
        .where(and(eq(games.drawId, current.id), eq(games.status, "NOT_STARTED")));

      await createSession(tx, current.eventId, current.teamSize, current.courtCount, current.queueMode, actor.id);
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.restart",
      entity: "draw",
      entityId: parsed.data.drawId,
    });

    revalidatePath("/", "layout");
    return success("Racha reiniciado com a lista atual.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function endRachaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(draws)
        .where(eq(draws.id, parsed.data.drawId))
        .for("update")
        .limit(1);
      if (!current) throw new AppError("Sessão não encontrada.");

      const [live] = await tx
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.drawId, current.id), eq(games.status, "IN_PROGRESS")))
        .limit(1);
      if (live) throw new AppError("Finalize a partida atual antes de encerrar o racha.");

      await tx
        .delete(games)
        .where(and(eq(games.drawId, current.id), eq(games.status, "NOT_STARTED")));
      await tx
        .update(draws)
        .set({ status: "FINISHED", finishedAt: new Date() })
        .where(eq(draws.id, current.id));
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.end",
      entity: "draw",
      entityId: parsed.data.drawId,
    });

    revalidatePath("/", "layout");
    return success("Racha encerrado.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function openCourtAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [draw] = await tx
        .select()
        .from(draws)
        .where(eq(draws.id, parsed.data.drawId))
        .for("update")
        .limit(1);
      if (!draw) throw new AppError("Sessão não encontrada.");

      const courts = await tx
        .select()
        .from(rotationCourts)
        .where(eq(rotationCourts.sessionId, draw.id))
        .orderBy(asc(rotationCourts.number));
      if (courts.length >= 20) throw new AppError("Limite de 20 quadras atingido.");

      const present = await loadPresent(tx, draw.eventId);
      const available = present.filter((row) => row.rotationStatus === "WAITING").length;
      if (available < draw.teamSize * 2) {
        throw new AppError(
          `Faltam ${draw.teamSize * 2 - available} jogador(es) na fila para abrir outra quadra.`,
        );
      }

      const number = Math.max(0, ...courts.map((row) => row.number)) + 1;
      await tx.insert(rotationCourts).values({
        sessionId: draw.id,
        number,
        status: "EMPTY",
      });
      await tx
        .update(draws)
        .set({ courtCount: courts.length + 1 })
        .where(eq(draws.id, draw.id));

      await mountNextForCourt(tx, draw, draw.eventId, number);
    });

    revalidatePath("/", "layout");
    return success("Quadra aberta.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function closeCourtAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaCourtSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [draw] = await tx
        .select()
        .from(draws)
        .where(eq(draws.id, parsed.data.drawId))
        .for("update")
        .limit(1);
      if (!draw) throw new AppError("Sessão não encontrada.");

      const [court] = await tx
        .select()
        .from(rotationCourts)
        .where(
          and(
            eq(rotationCourts.sessionId, draw.id),
            eq(rotationCourts.number, parsed.data.court),
          ),
        )
        .limit(1);
      if (!court) throw new AppError("Quadra não encontrada.");

      const [current] = await tx
        .select()
        .from(games)
        .where(
          and(
            eq(games.drawId, draw.id),
            eq(games.court, court.number),
            sql`${games.status} in ('IN_PROGRESS', 'NOT_STARTED')`,
          ),
        )
        .orderBy(desc(games.sequence))
        .limit(1);

      if (current) {
        const roster = await tx
          .select({ userId: gamePlayers.userId })
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, current.id));

        const courtPlayers = [
          ...((court.playerAIds as string[] | null) ?? []),
          ...((court.playerBIds as string[] | null) ?? []),
        ];

        if (current.status === "IN_PROGRESS") {
          await tx
            .update(games)
            .set({ status: "CANCELLED", updatedAt: new Date() })
            .where(eq(games.id, current.id));
        } else {
          await tx.delete(games).where(eq(games.id, current.id));
        }

        await appendPlayersToQueue(tx, draw.eventId, [
          ...roster.map((row) => row.userId),
          ...courtPlayers,
        ]);
      } else {
        await appendPlayersToQueue(tx, draw.eventId, [
          ...((court.playerAIds as string[] | null) ?? []),
          ...((court.playerBIds as string[] | null) ?? []),
        ]);
      }

      await normalizeOrphanPlayers(tx, draw.id, draw.eventId);
      await renumberQueue(tx, draw.eventId);

      await tx.delete(rotationCourts).where(eq(rotationCourts.id, court.id));
      const remaining = await tx
        .select({ number: rotationCourts.number })
        .from(rotationCourts)
        .where(eq(rotationCourts.sessionId, draw.id));
      await tx
        .update(draws)
        .set({ courtCount: remaining.length })
        .where(eq(draws.id, draw.id));
    });

    revalidatePath("/", "layout");
    return success("Quadra fechada.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function mixNextMatchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = gameIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [initial] = await tx
        .select({ drawId: games.drawId, eventId: games.eventId })
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .limit(1);
      if (!initial) throw new AppError("Partida não encontrada.");

      await tx.select().from(draws).where(eq(draws.id, initial.drawId)).for("update").limit(1);

      const [game] = await tx
        .select()
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .for("update")
        .limit(1);
      if (!game) throw new AppError("Partida não encontrada.");
      if (game.status !== "NOT_STARTED") {
        throw new AppError("Só é possível misturar uma partida que ainda não começou.");
      }

      const players = await tx
        .select({
          userId: gamePlayers.userId,
          teamId: gamePlayers.teamId,
          position: gamePlayers.position,
          role: gamePlayers.role,
          temporaryGoalkeeper: gamePlayers.temporaryGoalkeeper,
        })
        .from(gamePlayers)
        .where(and(eq(gamePlayers.gameId, game.id), isNull(gamePlayers.leftAt)));
      const fieldA = players
        .filter((row) => row.teamId === game.teamAId && row.position === "FIELD")
        .map((row) => row.userId);
      const fieldB = players
        .filter((row) => row.teamId === game.teamBId && row.position === "FIELD")
        .map((row) => row.userId);
      const goalkeepersA = players.filter(
        (row) => row.teamId === game.teamAId && row.position === "GOALKEEPER",
      );
      const goalkeepersB = players.filter(
        (row) => row.teamId === game.teamBId && row.position === "GOALKEEPER",
      );
      if (fieldA.length === 0 || fieldA.length !== fieldB.length) {
        throw new AppError("Os dois times precisam ter o mesmo número de jogadores de linha.");
      }

      const shuffled = shuffle([...fieldA, ...fieldB]);
      const teamSize = fieldA.length;
      const nextA = shuffled.slice(0, teamSize);
      const nextB = shuffled.slice(teamSize);

      await tx.delete(gamePlayers).where(eq(gamePlayers.gameId, game.id));
      await tx.insert(gamePlayers).values([
        ...nextA.map((userId) => ({
          gameId: game.id,
          teamId: game.teamAId,
          userId,
          position: "FIELD" as const,
        })),
        ...nextB.map((userId) => ({
          gameId: game.id,
          teamId: game.teamBId,
          userId,
          position: "FIELD" as const,
        })),
        ...goalkeepersA.map((row) => ({
          gameId: game.id,
          teamId: game.teamAId,
          userId: row.userId,
          role: row.role,
          position: "GOALKEEPER" as const,
          temporaryGoalkeeper: row.temporaryGoalkeeper,
        })),
        ...goalkeepersB.map((row) => ({
          gameId: game.id,
          teamId: game.teamBId,
          userId: row.userId,
          role: row.role,
          position: "GOALKEEPER" as const,
          temporaryGoalkeeper: row.temporaryGoalkeeper,
        })),
      ]);

      const rotationA = [...nextA, ...goalkeepersA.map((row) => row.userId)];
      const rotationB = [...nextB, ...goalkeepersB.map((row) => row.userId)];

      await tx
        .update(rotationCourts)
        .set({ playerAIds: rotationA, playerBIds: rotationB, updatedAt: new Date() })
        .where(
          and(
            eq(rotationCourts.sessionId, initial.drawId),
            eq(rotationCourts.number, game.court),
          ),
        );
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.mix",
      entity: "game",
      entityId: parsed.data.gameId,
    });

    revalidatePath("/", "layout");
    return success("Times misturados.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function setQueueModeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaQueueModeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db
      .update(draws)
      .set({ queueMode: parsed.data.mode })
      .where(eq(draws.id, parsed.data.drawId));
    revalidatePath("/", "layout");
    return success(
      parsed.data.mode === "KEEP_TEAM"
        ? "Fila mantém o time perdedor junto."
        : "Fila mistura os jogadores.",
    );
  } catch (error) {
    return actionFailure(error);
  }
}

export async function swapQueuePlayersAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaQueueSwapSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));
  if (parsed.data.attendanceId === parsed.data.targetAttendanceId) {
    return fail("Escolha outro jogador para trocar.");
  }

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(attendances)
        .where(
          inArray(attendances.id, [
            parsed.data.attendanceId,
            parsed.data.targetAttendanceId,
          ]),
        )
        .for("update");
      if (rows.length !== 2) throw new AppError("Jogador não encontrado na fila.");

      const [first, second] = rows.sort((a, b) => a.id.localeCompare(b.id));
      const source =
        first.id === parsed.data.attendanceId ? first : second;
      const target =
        first.id === parsed.data.targetAttendanceId ? first : second;

      if (
        source.eventId !== target.eventId ||
        source.rotationStatus !== "WAITING" ||
        target.rotationStatus !== "WAITING"
      ) {
        throw new AppError("Os dois jogadores precisam estar na fila de espera.");
      }

      await tx
        .update(attendances)
        .set({
          queuePosition: target.queuePosition,
          queueTeamId: target.queueTeamId,
          updatedAt: new Date(),
        })
        .where(eq(attendances.id, source.id));
      await tx
        .update(attendances)
        .set({
          queuePosition: source.queuePosition,
          queueTeamId: source.queueTeamId,
          updatedAt: new Date(),
        })
        .where(eq(attendances.id, target.id));
    });

    revalidatePath("/", "layout");
    return success("Jogadores trocados de posição.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function ensurePlayerAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = eventIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  const playerForm = new FormData();
  playerForm.set("eventId", parsed.data.eventId);
  playerForm.set("userId", actor.id);
  return addToRachaAction(_state, playerForm);
}

export async function ensureOrganizerAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = eventIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(eq(events.id, parsed.data.eventId))
        .for("update")
        .limit(1);
      if (!event) throw new AppError("Evento não encontrado.");

      const [existing] = await tx
        .select()
        .from(attendances)
        .where(
          and(
            eq(attendances.eventId, event.id),
            eq(attendances.userId, actor.id),
          ),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(attendances)
          .set({
            status: "CONFIRMED",
            isOrganizer: true,
            rotationStatus: "IDLE",
            queuePosition: null,
            updatedAt: new Date(),
          })
          .where(eq(attendances.id, existing.id));
      } else {
        await tx.insert(attendances).values({
          eventId: event.id,
          userId: actor.id,
          status: "CONFIRMED",
          isOrganizer: true,
          rotationStatus: "IDLE",
        });
      }
    });

    revalidatePath("/", "layout");
    return success("Agora você está apenas organizando.");
  } catch (error) {
    return actionFailure(error);
  }
}

export async function updateRachaTeamSizeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaTeamSizeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    await db
      .update(draws)
      .set({ teamSize: parsed.data.teamSize })
      .where(eq(draws.id, parsed.data.drawId));

    await recordAudit({
      actorId: actor.id,
      action: "racha.team_size",
      entity: "draw",
      entityId: parsed.data.drawId,
      details: { teamSize: parsed.data.teamSize },
    });

    revalidatePath("/", "layout");
    return success(`Times com ${parsed.data.teamSize} jogadores de linha. Vale para o próximo jogo.`);
  } catch (error) {
    return actionFailure(error);
  }
}

export async function setGoalkeeperAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rachaGoalkeeperSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstZodMessage(parsed.error));

  const actor = await getSessionUser();
  if (!actor || actor.role !== "ADMIN") return fail("Ação restrita a administradores.");

  try {
    const message = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(games)
        .where(eq(games.id, parsed.data.gameId))
        .for("update")
        .limit(1);
      if (!game) throw new AppError("Partida não encontrada.");
      if (game.teamAId !== parsed.data.teamId && game.teamBId !== parsed.data.teamId) {
        throw new AppError("Time não pertence a esta partida.");
      }

      const roster = await tx
        .select({
          userId: gamePlayers.userId,
          position: gamePlayers.position,
          role: gamePlayers.role,
          replacedUserId: gamePlayers.replacedUserId,
        })
        .from(gamePlayers)
        .where(
          and(
            eq(gamePlayers.gameId, game.id),
            eq(gamePlayers.teamId, parsed.data.teamId),
            isNull(gamePlayers.leftAt),
          ),
        );

      const extraGoalkeeper = roster.find(
        (row) =>
          row.position === "GOALKEEPER" &&
          row.role === "SUB" &&
          row.replacedUserId === null,
      );

      const syncCourtPlayers = async (userId: string, add: boolean) => {
        const [court] = await tx
          .select()
          .from(rotationCourts)
          .where(
            and(
              eq(rotationCourts.sessionId, game.drawId),
              eq(rotationCourts.number, game.court),
            ),
          )
          .limit(1);
        if (!court) return;
        const isTeamA = game.teamAId === parsed.data.teamId;
        const ids = new Set<string>(
          ((isTeamA ? court.playerAIds : court.playerBIds) as string[] | null) ?? [],
        );
        if (add) ids.add(userId);
        else ids.delete(userId);
        await tx
          .update(rotationCourts)
          .set(
            isTeamA
              ? { playerAIds: [...ids], updatedAt: new Date() }
              : { playerBIds: [...ids], updatedAt: new Date() },
          )
          .where(eq(rotationCourts.id, court.id));
      };

      const removeExtraGoalkeeper = async (userId: string) => {
        await tx
          .delete(gamePlayers)
          .where(
            and(
              eq(gamePlayers.gameId, game.id),
              eq(gamePlayers.teamId, parsed.data.teamId),
              eq(gamePlayers.userId, userId),
            ),
          );
        await appendPlayersToQueue(tx, game.eventId, [userId]);
        await syncCourtPlayers(userId, false);
      };

      if (!parsed.data.userId) {
        if (extraGoalkeeper) await removeExtraGoalkeeper(extraGoalkeeper.userId);
        await tx
          .update(gamePlayers)
          .set({ position: "FIELD", temporaryGoalkeeper: false })
          .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.teamId, parsed.data.teamId)));
        return "Goleiro removido do time.";
      }

      const targetUserId = parsed.data.userId;
      const [preference] = await tx
        .select({
          value: sql<"FIXED" | "FIELD" | "ANY">`coalesce(${attendances.goalkeeperPreference}, ${users.goalkeeperPreference})`,
          active: users.active,
          status: attendances.status,
          rotationStatus: attendances.rotationStatus,
        })
        .from(attendances)
        .innerJoin(users, eq(users.id, attendances.userId))
        .where(
          and(
            eq(attendances.eventId, game.eventId),
            eq(attendances.userId, targetUserId),
          ),
        )
        .limit(1);
      if (!preference || !preference.active || preference.status !== "CONFIRMED") {
        throw new AppError("O goleiro precisa estar confirmado no evento.");
      }
      if (preference.rotationStatus === "LEFT") {
        throw new AppError("O goleiro escolhido já saiu do racha.");
      }

      const inRoster = roster.some((row) => row.userId === targetUserId);

      if (inRoster) {
        if (extraGoalkeeper && extraGoalkeeper.userId !== targetUserId) {
          await removeExtraGoalkeeper(extraGoalkeeper.userId);
        }
        await tx
          .update(gamePlayers)
          .set({ position: "FIELD", temporaryGoalkeeper: false })
          .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.teamId, parsed.data.teamId)));
        await tx
          .update(gamePlayers)
          .set({
            position: "GOALKEEPER",
            temporaryGoalkeeper: preference.value !== "FIXED",
          })
          .where(
            and(
              eq(gamePlayers.gameId, game.id),
              eq(gamePlayers.teamId, parsed.data.teamId),
              eq(gamePlayers.userId, targetUserId),
            ),
          );
        return "Goleiro definido.";
      }

      const [activeElsewhere] = await tx
        .select({ id: gamePlayers.id })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .where(
          and(
            eq(gamePlayers.userId, targetUserId),
            eq(games.drawId, game.drawId),
            sql`${games.status} in ('IN_PROGRESS', 'NOT_STARTED')`,
            isNull(gamePlayers.leftAt),
          ),
        )
        .limit(1);
      if (activeElsewhere) {
        throw new AppError("Este jogador já está em outra partida.");
      }

      if (extraGoalkeeper) await removeExtraGoalkeeper(extraGoalkeeper.userId);

      await tx
        .update(gamePlayers)
        .set({ position: "FIELD", temporaryGoalkeeper: false })
        .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.teamId, parsed.data.teamId)));

      await tx.insert(gamePlayers).values({
        gameId: game.id,
        teamId: parsed.data.teamId,
        userId: targetUserId,
        role: "SUB",
        position: "GOALKEEPER",
        temporaryGoalkeeper: preference.value !== "FIXED",
        replacedUserId: null,
      });
      await tx
        .update(attendances)
        .set({
          rotationStatus: "PLAYING",
          queuePosition: null,
          queueTeamId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(attendances.eventId, game.eventId),
            eq(attendances.userId, targetUserId),
          ),
        );
      await syncCourtPlayers(targetUserId, true);

      return "Goleiro adicionado ao time.";
    });

    await recordAudit({
      actorId: actor.id,
      action: "racha.goalkeeper",
      entity: "game",
      entityId: parsed.data.gameId,
      details: { teamId: parsed.data.teamId, userId: parsed.data.userId },
    });

    revalidatePath("/", "layout");
    return success(message);
  } catch (error) {
    return actionFailure(error);
  }
}
