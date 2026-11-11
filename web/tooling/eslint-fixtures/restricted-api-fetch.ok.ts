import { apiGet } from "../../src/api/typedClient";
export function load() {
  return apiGet("/api/current-work");
}
