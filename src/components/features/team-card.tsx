import { Hand } from "lucide-react";
import {
  goalkeeperPreferenceLabel,
  readableTextColor,
  teamVisualByColor,
} from "@/lib/teams";
import { cn } from "@/lib/utils";

export type TeamCardTeam = {
  id?: string;
  name: string;
  color: string;
  players: {
    userId: string;
    name: string;
    memberType?: "MEMBER" | "GUEST";
    position?: "GOALKEEPER" | "FIELD";
    temporaryGoalkeeper?: boolean;
    goalkeeperPreference?: "FIXED" | "FIELD" | "ANY";
  }[];
};

function MemberTag({ memberType }: { memberType?: "MEMBER" | "GUEST" }) {
  if (!memberType) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider",
        memberType === "GUEST" ? "bg-ink/5 text-muted" : "bg-brand/10 text-brand",
      )}
    >
      {memberType === "GUEST" ? "Convidado" : "Membro"}
    </span>
  );
}

export function TeamCard({
  team,
  teamSize,
  className,
  highlight,
  compact,
}: {
  team: TeamCardTeam;
  teamSize?: number;
  className?: string;
  highlight?: boolean;
  compact?: boolean;
}) {
  const visual = teamVisualByColor(team.color);
  const foreground = readableTextColor(visual.hex);
  const goalkeeper = team.players.find((player) => player.position === "GOALKEEPER") ?? null;
  const fieldPlayers = team.players.filter((player) => player !== goalkeeper);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border transition-all duration-300",
        highlight
          ? "border-line-strong bg-surface-2/90 shadow-[0_10px_24px_-16px_rgba(0,0,0,0.35)]"
          : "border-line bg-surface/60",
        className,
      )}
    >
      <div
        className="h-1.5 w-full shadow-[0_1px_6px]"
        style={{
          backgroundColor: visual.hex,
          color: visual.hex,
        }}
      />
      <div className={cn("flex items-center justify-between gap-2", compact ? "px-2.5 pt-2.5" : "px-3.5 pt-3")}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{
              backgroundColor: visual.hex,
              boxShadow: `0 0 0 1px ${foreground}55, 0 0 8px ${visual.hex}`,
            }}
          />
          <p
            className={cn(
              "truncate font-display font-bold uppercase tracking-wider text-ink",
              compact ? "text-sm" : "text-base",
            )}
          >
            {team.name}
          </p>
        </div>
        <span
          className="rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-ink"
          style={{ backgroundColor: visual.soft }}
        >
          {fieldPlayers.length}
          {teamSize ? `/${teamSize}` : ""}
        </span>
      </div>

      <div
        className={cn(
          "flex items-center gap-2 rounded-xl border",
          compact ? "mx-2 mt-2 px-2 py-1.5" : "mx-3 mt-2.5 px-2.5 py-2",
          goalkeeper
            ? "border-[rgba(245,185,66,0.45)] bg-[rgba(245,185,66,0.12)]"
            : "border-dashed border-line bg-surface-2/40",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[rgba(245,185,66,0.16)] text-warning">
          <Hand className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-bold uppercase tracking-wider text-warning">Goleiro</p>
          <p className={cn("truncate font-semibold text-ink", compact ? "text-sm" : "text-sm")}>
            {goalkeeper ? (
              <span className="mr-1 rounded bg-[rgba(245,185,66,0.2)] px-1 text-[9px] font-bold uppercase tracking-wider text-warning">
                {goalkeeperPreferenceLabel(goalkeeper.goalkeeperPreference)}
              </span>
            ) : null}
            {goalkeeper ? goalkeeper.name : "Pendente"}
          </p>
        </div>
        {goalkeeper?.temporaryGoalkeeper ? (
          <span className="shrink-0 rounded bg-[rgba(245,185,66,0.18)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-warning">
            Temporário
          </span>
        ) : null}
        <MemberTag memberType={goalkeeper?.memberType} />
      </div>

      <ol className={cn(compact ? "space-y-1 px-2 py-2" : "space-y-1.5 px-3 py-3")}>
        {fieldPlayers.map((player, index) => (
          <li
            key={player.userId}
            className={cn(
              "flex items-center gap-2 rounded-xl bg-ink/[0.02] font-medium text-ink transition hover:bg-ink/[0.06]",
              compact ? "px-1.5 py-1.5 text-sm" : "gap-2.5 px-2.5 py-1.5 text-sm",
            )}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ink/5 text-[11px] font-bold text-muted">
              {index + 1}
            </span>
            <span className="shrink-0 rounded bg-brand/10 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand">
              {goalkeeperPreferenceLabel(player.goalkeeperPreference)}
            </span>
            <span className="truncate">{player.name}</span>
            <MemberTag memberType={player.memberType} />
          </li>
        ))}
        {fieldPlayers.length === 0 ? (
          <li className="px-2 py-3 text-center text-xs text-muted">Sem jogadores de linha escalados</li>
        ) : null}
      </ol>
    </div>
  );
}

export function TeamPill({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  const visual = teamVisualByColor(color);
  const ring = readableTextColor(visual.hex);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold text-ink",
        className,
      )}
      style={{ borderColor: `${visual.hex}66`, backgroundColor: visual.soft }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: visual.hex,
          boxShadow: `0 0 0 1px ${ring}66`,
        }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}
