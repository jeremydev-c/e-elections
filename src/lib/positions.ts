export const POSITIONS = ["PRESIDENT", "GOVERNOR", "SENATOR", "WOMAN_REP", "MP", "MCA"] as const;
export type Position = (typeof POSITIONS)[number];

export const POSITION_LABELS: Record<Position, string> = {
  PRESIDENT: "President",
  GOVERNOR: "Governor",
  SENATOR: "Senator",
  WOMAN_REP: "Woman Representative",
  MP: "Member of Parliament",
  MCA: "Member of County Assembly",
};

/** Which region level each seat is contested at. */
export const POSITION_LEVEL = {
  PRESIDENT: "national",
  GOVERNOR: "county",
  SENATOR: "county",
  WOMAN_REP: "county",
  MP: "constituency",
  MCA: "ward",
} as const satisfies Record<Position, "national" | "county" | "constituency" | "ward">;

type VoterRegion = { countyCode: string; constituencyCode: string; wardCode: string };

/** The candidate `regionCode` a voter's ballot must use for each seat. */
export function regionCodeFor(position: Position, v: VoterRegion): string {
  switch (POSITION_LEVEL[position]) {
    case "national":
      return "KE";
    case "county":
      return v.countyCode;
    case "constituency":
      return v.constituencyCode;
    case "ward":
      return v.wardCode;
  }
}

/** Kenya is UTC+3 all year (no daylight saving). */
export function formatVotedAt(votedAt: Date | string | null | undefined): string {
  if (!votedAt) return "an earlier time";
  const start = new Date(votedAt);
  const end = new Date(start.getTime() + 3_600_000);
  const day = start.toLocaleDateString("en-GB", { timeZone: "Africa/Nairobi", day: "numeric", month: "short", year: "numeric" });
  const hh = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit" });
  return `${day}, ${hh(start)}–${hh(end)} EAT`;
}

export function alreadyVotedMessage(idNumber: string, votedAt: Date | string | null | undefined): string {
  return `ACCESS DENIED: National ID ${idNumber} has already cast a ballot at ${formatVotedAt(votedAt)}. Double voting is strictly prevented.`;
}
