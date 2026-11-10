import { apiGet } from "../../src/api/typedClient";
export const load = () => apiGet("/api/current-work");
export const loadModule = () => import("../../src/api/typedClient");
export const named = (name: string) => import(`../../src/${name}`);
