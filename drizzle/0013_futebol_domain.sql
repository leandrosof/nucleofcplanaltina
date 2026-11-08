-- Núcleo FC: futebol, gratuito, membro/convidado e goleiros.

-- Enums novos
CREATE TYPE "member_type" AS ENUM ('MEMBER', 'GUEST');
CREATE TYPE "goalkeeper_preference" AS ENUM ('FIXED', 'FIELD', 'ANY');
CREATE TYPE "game_player_position" AS ENUM ('GOALKEEPER', 'FIELD');

-- attendance_status sem PENDING_PAYMENT
ALTER TABLE "attendances" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "attendances" SET "status" = 'CONFIRMED' WHERE "status" = 'PENDING_PAYMENT';
ALTER TYPE "attendance_status" RENAME TO "attendance_status_old";
CREATE TYPE "attendance_status" AS ENUM ('CONFIRMED', 'WAITLIST', 'CANCELLED');
ALTER TABLE "attendances"
  ALTER COLUMN "status" TYPE "attendance_status"
  USING ("status"::text::"attendance_status");
ALTER TABLE "attendances" ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';
DROP TYPE "attendance_status_old";

-- event_surface com pisos de futebol
ALTER TABLE "events" ALTER COLUMN "surface" DROP DEFAULT;
ALTER TYPE "event_surface" RENAME TO "event_surface_old";
CREATE TYPE "event_surface" AS ENUM ('GRASS', 'SOCIETY', 'FUTSAL', 'SAND');
ALTER TABLE "events"
  ALTER COLUMN "surface" TYPE "event_surface"
  USING (
    CASE "surface"::text
      WHEN 'SAND' THEN 'SAND'
      WHEN 'COURT' THEN 'GRASS'
      ELSE NULL
    END
  )::"event_surface";
DROP TYPE "event_surface_old";

-- Remoção de pagamento dos eventos
ALTER TABLE "events" DROP COLUMN IF EXISTS "payment_mode";
ALTER TABLE "events" DROP COLUMN IF EXISTS "price_cents";
ALTER TABLE "events" DROP COLUMN IF EXISTS "auto_payment_review";

-- Remoção de pagamento das presenças e override de goleiro
ALTER TABLE "attendances" DROP COLUMN IF EXISTS "payment_approved_at";
ALTER TABLE "attendances" DROP COLUMN IF EXISTS "payment_approved_by_id";
ALTER TABLE "attendances" DROP COLUMN IF EXISTS "payment_reference";
ALTER TABLE "attendances" DROP COLUMN IF EXISTS "reservation_expires_at";
ALTER TABLE "attendances" ADD COLUMN "goalkeeper_preference" "goalkeeper_preference";

-- Cadastro Membro/Convidado e preferência de goleiro
ALTER TABLE "users" ADD COLUMN "member_type" "member_type" DEFAULT 'MEMBER' NOT NULL;
ALTER TABLE "users" ADD COLUMN "goalkeeper_preference" "goalkeeper_preference" DEFAULT 'FIELD' NOT NULL;

-- Posição e goleiro temporário na partida
ALTER TABLE "game_players" ADD COLUMN "position" "game_player_position" DEFAULT 'FIELD' NOT NULL;
ALTER TABLE "game_players" ADD COLUMN "temporary_goalkeeper" boolean DEFAULT false NOT NULL;

-- Configurações: empate, tamanho 7 e branding
ALTER TABLE "settings" DROP COLUMN IF EXISTS "pix_key";
ALTER TABLE "settings" DROP COLUMN IF EXISTS "pix_recipient_name";
ALTER TABLE "settings" DROP COLUMN IF EXISTS "pix_instructions";
ALTER TABLE "settings" ADD COLUMN "points_draw" integer DEFAULT 1 NOT NULL;
ALTER TABLE "settings" ALTER COLUMN "default_team_size" SET DEFAULT 7;
ALTER TABLE "settings" ALTER COLUMN "site_name" SET DEFAULT 'Núcleo FC';
UPDATE "settings" SET "site_name" = 'Núcleo FC' WHERE "site_name" IN ('Arena do Vôlei', 'Arena do Volei');
UPDATE "settings"
  SET "default_team_size" = 7
  WHERE "default_team_size" < 6 OR "default_team_size" > 11;
UPDATE "settings" SET "points_draw" = 1 WHERE "points_draw" IS NULL;

-- Remoção total do pagamento
DROP TABLE IF EXISTS "payment_proofs";
DROP TYPE IF EXISTS "payment_proof_status";
DROP TYPE IF EXISTS "event_payment_mode";
