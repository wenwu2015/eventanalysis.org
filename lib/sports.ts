import sportData from "../content/sports.json" with { type: "json" };

export type SportCode = "football" | "basketball" | "volleyball" | "badminton";
export type SportStatus = "active" | "planned";

export type SportDefinition = {
  code: SportCode;
  name: string;
  status: SportStatus;
  routeSegment: string;
  eventSchema: "sports-event-v1";
};

export const sportDefinitions = sportData as SportDefinition[];
export const sportByCode = Object.fromEntries(
  sportDefinitions.map((sport) => [sport.code, sport]),
) as Record<SportCode, SportDefinition>;
export const activeSports = sportDefinitions.filter((sport) => sport.status === "active");
