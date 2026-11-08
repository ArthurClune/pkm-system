// pattern: Imperative Shell
// The property suite's own setup (vitest.props.config.ts). Every property
// gives way to the vitest worker between examples (giveWay.ts), so a long
// run cannot fail the gate on the worker's RPC timeout. Setting a global
// asyncBeforeEach also makes fast-check refuse to build a synchronous
// fc.property ("asyncBeforeEach can't be set when running synchronous
// properties"): that refusal is the rule. Write fc.asyncProperty.
import fc from "fast-check";
import { makeGiveWay } from "./giveWay";

fc.configureGlobal({ ...fc.readConfigureGlobal(), asyncBeforeEach: makeGiveWay() });
