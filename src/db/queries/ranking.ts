import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { db } from "../client";
import { gamePlayers, games, users } from "../schema";

export type RankingEntry = {
  userId: string;
  name: string;
  nickname: string | null;
  avatarUpdatedAt: Date | null;
  memberType: "MEMBER" | "GUEST";
  played: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  points: number;
  position: number;
};

export type RankingRange = { from: Date | null; to: Date | null };

export async function getRanking(
  range: RankingRange,
  pointsWin: number,
  pointsDraw: number,
  pointsLoss: number,
  memberFilter?: "MEMBER" | "GUEST" | null,
): Promise<RankingEntry[]> {
  const conditions = [eq(games.status, "FINISHED")];
  if (range.from) conditions.push(gte(games.finishedAt, range.from));
  if (range.to) conditions.push(lt(games.finishedAt, range.to));
  if (memberFilter) conditions.push(eq(users.memberType, memberFilter));

  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      nickname: users.nickname,
      avatarUpdatedAt: users.avatarUpdatedAt,
      memberType: users.memberType,
      played: sql<number>`count(distinct ${games.id})`.mapWith(Number),
      wins: sql<number>`count(distinct case when ${games.winnerTeamId} = ${gamePlayers.teamId} then ${games.id} end)`.mapWith(Number),
      draws: sql<number>`count(distinct case when ${games.winnerTeamId} is null then ${games.id} end)`.mapWith(Number),
    })
    .from(games)
    .innerJoin(
      gamePlayers,
      and(
        eq(gamePlayers.gameId, games.id),
        or(eq(gamePlayers.teamId, games.teamAId), eq(gamePlayers.teamId, games.teamBId)),
      ),
    )
    .innerJoin(users, eq(users.id, gamePlayers.userId))
    .where(and(...conditions))
    .groupBy(users.id, users.name, users.nickname, users.avatarUpdatedAt, users.memberType);

  const entries = rows.map((row) => {
    const played = Number(row.played);
    const wins = Number(row.wins);
    const draws = Number(row.draws);
    const losses = Math.max(played - wins - draws, 0);
    return {
      userId: row.userId,
      name: row.name,
      nickname: row.nickname,
      avatarUpdatedAt: row.avatarUpdatedAt,
      memberType: row.memberType,
      played,
      wins,
      draws,
      losses,
      winRate: played > 0 ? Math.round((wins / played) * 100) : 0,
      points: wins * pointsWin + draws * pointsDraw + losses * pointsLoss,
    };
  });

  entries.sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.winRate - a.winRate ||
      b.played - a.played ||
      a.name.localeCompare(b.name, "pt-BR"),
  );

  return entries.map((entry, index) => ({ ...entry, position: index + 1 }));
}

export async function getPlayerRankingEntry(
  userId: string,
  range: RankingRange,
  pointsWin: number,
  pointsDraw: number,
  pointsLoss: number,
): Promise<{ entry: RankingEntry | null; totalPlayers: number }> {
  const ranking = await getRanking(range, pointsWin, pointsDraw, pointsLoss);
  return {
    entry: ranking.find((row) => row.userId === userId) ?? null,
    totalPlayers: ranking.length,
  };
}
