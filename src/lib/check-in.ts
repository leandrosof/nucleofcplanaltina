import { TZDate } from "@date-fns/tz";
import { formatTime } from "./time";

const HOUR_MS = 60 * 60 * 1000;
export const CHECK_IN_HOURS_BEFORE = 2;
export const CHECK_IN_HOURS_AFTER = 2;

export type CheckInEvent = {
  startsAt: Date;
  endsAt: Date | null;
};

export type CheckInWindow = {
  opensAt: Date;
  closesAt: Date;
};

export function getCheckInWindow(event: CheckInEvent, timeZone: string): CheckInWindow {
  const opensAt = new Date(event.startsAt.getTime() - CHECK_IN_HOURS_BEFORE * HOUR_MS);

  if (event.endsAt) {
    return {
      opensAt,
      closesAt: new Date(event.endsAt.getTime() + CHECK_IN_HOURS_AFTER * HOUR_MS),
    };
  }

  const zoned = new TZDate(event.startsAt, timeZone);
  const endOfDay = new TZDate(
    zoned.getFullYear(),
    zoned.getMonth(),
    zoned.getDate(),
    23,
    59,
    59,
    999,
    timeZone,
  );

  return { opensAt, closesAt: new Date(endOfDay.getTime()) };
}

export function isCheckInWindowOpen(window: CheckInWindow, now: Date = new Date()): boolean {
  return (
    now.getTime() >= window.opensAt.getTime() && now.getTime() <= window.closesAt.getTime()
  );
}

export function canPlayerCheckIn(input: {
  event: CheckInEvent;
  timeZone: string;
  role: "ADMIN" | "PLAYER";
  rachaInProgress: boolean;
  now?: Date;
}): boolean {
  if (input.role === "ADMIN") return true;
  if (input.rachaInProgress) return true;
  return isCheckInWindowOpen(getCheckInWindow(input.event, input.timeZone), input.now);
}

export function checkInNotice(input: {
  event: CheckInEvent;
  timeZone: string;
  isAdmin: boolean;
  rachaInProgress: boolean;
  now?: Date;
}): string {
  if (input.isAdmin) {
    return "Como admin, você pode marcar chegada a qualquer momento.";
  }
  if (input.rachaInProgress) {
    return "Chegada liberada enquanto o racha estiver em andamento.";
  }

  const now = input.now ?? new Date();
  const window = getCheckInWindow(input.event, input.timeZone);

  if (now.getTime() < window.opensAt.getTime()) {
    return `Chegada liberada a partir de ${formatTime(
      window.opensAt,
      input.timeZone,
    )}. Marque somente quando estiver no local.`;
  }

  if (now.getTime() > window.closesAt.getTime()) {
    return `A janela de chegada encerrou às ${formatTime(
      window.closesAt,
      input.timeZone,
    )}. Fale com um administrador.`;
  }

  return `Chegada liberada até ${formatTime(
    window.closesAt,
    input.timeZone,
  )}. Marque somente quando estiver no local.`;
}
