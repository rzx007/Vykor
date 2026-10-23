import { App } from "@modelcontextprotocol/ext-apps";
import { createPluginAppClient } from "../app-client.mjs";
import { createWeatherTools } from "../../src/app-tools.mjs";

const client = createPluginAppClient(new App({ name: "weather-type-check", version: "1.0.0" }));
const tools = createWeatherTools({
  SearchPlaces: "WeatherSearchPlaces", GetForecast: "WeatherGetForecast", ReadPlan: "WeatherReadPlan",
  SavePlanDraft: "WeatherSavePlanDraft", ReadFavorites: "WeatherReadFavorites", SetFavorite: "WeatherSetFavorite",
  ExportPlan: "WeatherExportPlan", GetOperation: "WeatherGetOperation",
});
async function checkTypes() {
  const result = await client.call(tools.SearchPlaces, { query: "Shanghai" });
  if (result.structuredContent?.kind === "places") {
    const latitude: number | undefined = result.structuredContent.places[0]?.latitude;
    void latitude;
  }
  // @ts-expect-error City searches take text, not coordinates.
  await client.call(tools.SearchPlaces, { query: 42 });
  // @ts-expect-error Exports require the original revision and operation ID.
  await client.call(tools.ExportPlan, { path: "trip.md", format: "markdown" });
}
void checkTypes;
