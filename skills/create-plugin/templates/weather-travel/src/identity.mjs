import config from "../plugin.config.json" with { type: "json" };

export { config };
export const names = Object.fromEntries([
  "SearchPlaces", "GetForecast", "ReadPlan", "ApplyPlanOperations", "SavePlanDraft",
  "ReadFavorites", "SetFavorite", "ExportPlan", "GetOperation",
].map(key => [key, `${config.toolPrefix}${key}`]));
export const resourceUri = `ui://${config.name}/panel`;
export const planUri = `${config.name}://trip`;
