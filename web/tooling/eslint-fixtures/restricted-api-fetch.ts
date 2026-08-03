import { apiFetch } from "../../src/api/client";

export function load() {
  return apiFetch("/api/current-work");
}
