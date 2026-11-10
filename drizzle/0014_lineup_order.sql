-- Ordem real da escalação no card/fila do racha.
ALTER TABLE "game_players" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;

-- Backfill aproximado para jogos antigos (a ordem original não foi gravada).
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "game_id", "team_id"
      ORDER BY "entered_at", "id"
    ) - 1 AS rn
  FROM "game_players"
)
UPDATE "game_players"
SET "sort_order" = ranked.rn
FROM ranked
WHERE "game_players"."id" = ranked.id;
