export type TeamVisual = {
  name: string;
  color: string;
  hex: string;
  soft: string;
};

type TeamPaletteSeed = {
  name: string;
  color: string;
  hex: string;
};

const TEAM_PALETTE_SEED: TeamPaletteSeed[] = [
  { name: "Azul", color: "blue", hex: "#2f6bff" },
  { name: "Vermelho", color: "red", hex: "#ef4444" },
];

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const normalized =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

export const TEAM_PALETTE: TeamVisual[] = TEAM_PALETTE_SEED.map((item) => ({
  ...item,
  soft: hexToRgba(item.hex, 0.16),
}));

export function readableTextColor(hex: string): string {
  const value = hex.replace("#", "");
  const normalized =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.45 ? "#0b1220" : "#f8fafc";
}

export function teamVisualForIndex(index: number): TeamVisual {
  const name = `Time ${index + 1}`;
  const palette = TEAM_PALETTE[index % TEAM_PALETTE.length] ?? TEAM_PALETTE[0];
  return { ...palette, name };
}

export function teamVisualByColor(color: string): TeamVisual {
  if (color.startsWith("#")) {
    return {
      name: color,
      color,
      hex: color,
      soft: hexToRgba(color, 0.16),
    };
  }
  return TEAM_PALETTE.find((item) => item.color === color) ?? TEAM_PALETTE[0];
}

export function teamVisualByIndex(index: number): TeamVisual {
  return teamVisualForIndex(index);
}

export type GoalkeeperPreference = "FIXED" | "FIELD" | "ANY";

export const GOALKEEPER_PREFERENCE_LABELS: Record<GoalkeeperPreference, string> = {
  FIXED: "GOL",
  ANY: "GL",
  FIELD: "LIN",
};

export function goalkeeperPreferenceLabel(
  preference: GoalkeeperPreference | null | undefined,
): string {
  return preference ? GOALKEEPER_PREFERENCE_LABELS[preference] : "LIN";
}

export const TEAM_SIZE_OPTIONS = [6, 7, 8, 9, 10, 11] as const;
export const MAX_PLAYERS_LIMIT = 200;
export const MIN_PLAYERS_LIMIT = 2;
