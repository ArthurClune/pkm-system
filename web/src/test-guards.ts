// Setup shared by the unit suite (vite.config.ts) and the property suite
// (vitest.props.config.ts), so it stays free of jsdom: guards against a test
// run that spins a worker past every timeout vitest has.
import { capFilters } from "./fcFilterCap";
import { startOrphanWatchdog } from "./orphanWatchdog";

capFilters();
startOrphanWatchdog();
