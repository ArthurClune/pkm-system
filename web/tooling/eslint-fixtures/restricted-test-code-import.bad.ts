import { openTestDb } from "../../src/replica/testDb";
import { memReplica } from "../../src/sync/memReplica";

export const fixtures = [openTestDb, memReplica];
export const load = () => import(`../../src/${"replica"}/testDb`);
export const loadHelpers = () => import(`../../src/test-helpers`);
export const loadReplica = () => import("../../src/sync/memReplica");
