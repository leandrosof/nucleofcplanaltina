import { Badge } from "@/components/ui/badge";

export function MemberBadge({ memberType }: { memberType: "MEMBER" | "GUEST" }) {
  return (
    <Badge tone={memberType === "MEMBER" ? "brand" : "neutral"} className="shrink-0">
      {memberType === "MEMBER" ? "Membro" : "Convidado"}
    </Badge>
  );
}

export function GoalkeeperBadge({
  preference,
}: {
  preference: "FIXED" | "FIELD" | "ANY";
}) {
  if (preference === "FIXED") {
    return (
      <Badge tone="warning" className="shrink-0">
        Goleiro fixo
      </Badge>
    );
  }
  if (preference === "ANY") {
    return (
      <Badge tone="neutral" className="shrink-0">
        Pode ir no gol
      </Badge>
    );
  }
  return null;
}
