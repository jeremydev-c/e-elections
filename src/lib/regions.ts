import regionsData from "@/data/regions.json";

export type Ward = { code: string; name: string };
export type Constituency = { code: string; name: string; wards: Ward[] };
export type County = { code: string; name: string; constituencies: Constituency[] };

export const COUNTIES = regionsData as County[];

const countyByCode = new Map<string, County>();
const constituencyByCode = new Map<string, Constituency & { countyCode: string }>();
const wardByCode = new Map<string, Ward & { constituencyCode: string; countyCode: string }>();

for (const county of COUNTIES) {
  countyByCode.set(county.code, county);
  for (const c of county.constituencies) {
    constituencyByCode.set(c.code, { ...c, countyCode: county.code });
    for (const w of c.wards) {
      wardByCode.set(w.code, { ...w, constituencyCode: c.code, countyCode: county.code });
    }
  }
}

export const getCounty = (code: string) => countyByCode.get(code);
export const getConstituency = (code: string) => constituencyByCode.get(code);
export const getWard = (code: string) => wardByCode.get(code);

/**
 * Validates that a ward belongs to the given constituency, and the
 * constituency to the given county. Used on the server so a tampered
 * registration request can't create an impossible region combination.
 */
export function isValidRegion(countyCode: string, constituencyCode: string, wardCode: string) {
  const ward = wardByCode.get(wardCode);
  return !!ward && ward.constituencyCode === constituencyCode && ward.countyCode === countyCode;
}
