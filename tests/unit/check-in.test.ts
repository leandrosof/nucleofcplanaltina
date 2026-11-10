import { describe, expect, it } from "vitest";
import {
  canPlayerCheckIn,
  checkInNotice,
  getCheckInWindow,
  isCheckInWindowOpen,
} from "@/lib/check-in";

const TIME_ZONE = "America/Sao_Paulo";
const STARTS_AT = new Date("2026-11-10T19:00:00-03:00");
const ENDS_AT = new Date("2026-11-10T21:00:00-03:00");

describe("getCheckInWindow", () => {
  it("abre 2h antes e fecha 2h depois do término cadastrado", () => {
    const window = getCheckInWindow({ startsAt: STARTS_AT, endsAt: ENDS_AT }, TIME_ZONE);

    expect(window.opensAt.toISOString()).toBe(
      new Date("2026-11-10T17:00:00-03:00").toISOString(),
    );
    expect(window.closesAt.toISOString()).toBe(
      new Date("2026-11-10T23:00:00-03:00").toISOString(),
    );
  });

  it("sem endsAt fecha no fim do dia do evento no fuso do grupo", () => {
    const window = getCheckInWindow({ startsAt: STARTS_AT, endsAt: null }, TIME_ZONE);

    expect(window.closesAt.toISOString()).toBe(
      new Date("2026-11-10T23:59:59.999-03:00").toISOString(),
    );
  });
});

describe("isCheckInWindowOpen", () => {
  const window = getCheckInWindow({ startsAt: STARTS_AT, endsAt: ENDS_AT }, TIME_ZONE);

  it("respeita os limites", () => {
    expect(isCheckInWindowOpen(window, new Date("2026-11-10T16:59:59-03:00"))).toBe(false);
    expect(isCheckInWindowOpen(window, new Date("2026-11-10T17:00:00-03:00"))).toBe(true);
    expect(isCheckInWindowOpen(window, new Date("2026-11-10T22:59:59-03:00"))).toBe(true);
    expect(isCheckInWindowOpen(window, new Date("2026-11-10T23:00:01-03:00"))).toBe(false);
  });
});

describe("canPlayerCheckIn", () => {
  it("admin pode sempre", () => {
    expect(
      canPlayerCheckIn({
        event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
        timeZone: TIME_ZONE,
        role: "ADMIN",
        rachaInProgress: false,
        now: new Date("2026-11-10T10:00:00-03:00"),
      }),
    ).toBe(true);
  });

  it("jogador fora da janela não pode, mas com racha em andamento pode", () => {
    expect(
      canPlayerCheckIn({
        event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
        timeZone: TIME_ZONE,
        role: "PLAYER",
        rachaInProgress: false,
        now: new Date("2026-11-10T10:00:00-03:00"),
      }),
    ).toBe(false);

    expect(
      canPlayerCheckIn({
        event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
        timeZone: TIME_ZONE,
        role: "PLAYER",
        rachaInProgress: true,
        now: new Date("2026-11-10T10:00:00-03:00"),
      }),
    ).toBe(true);
  });

  it("jogador pode dentro da janela", () => {
    expect(
      canPlayerCheckIn({
        event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
        timeZone: TIME_ZONE,
        role: "PLAYER",
        rachaInProgress: false,
        now: new Date("2026-11-10T19:00:00-03:00"),
      }),
    ).toBe(true);
  });
});

describe("checkInNotice", () => {
  it("mostra a abertura real para jogador", () => {
    const notice = checkInNotice({
      event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
      timeZone: TIME_ZONE,
      isAdmin: false,
      rachaInProgress: false,
      now: new Date("2026-11-10T10:00:00-03:00"),
    });

    expect(notice).toContain("Chegada liberada a partir de 17:00");
    expect(notice).toContain("Marque somente quando estiver no local");
  });

  it("admin e racha em andamento têm avisos próprios", () => {
    expect(
      checkInNotice({
        event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
        timeZone: TIME_ZONE,
        isAdmin: true,
        rachaInProgress: false,
      }),
    ).toContain("a qualquer momento");

    expect(
      checkInNotice({
        event: { startsAt: STARTS_AT, endsAt: ENDS_AT },
        timeZone: TIME_ZONE,
        isAdmin: false,
        rachaInProgress: true,
      }),
    ).toContain("enquanto o racha estiver em andamento");
  });
});
