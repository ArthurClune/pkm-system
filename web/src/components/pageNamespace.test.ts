// The namespace of a page title is the prefix before its first "/" --
// [[AWS/EC2]] is in "aws". Used to colour refs by tree (pkm-r71a).
import { expect, test } from "vitest";
import { pageNamespace } from "./pageNamespace";

test("returns the lowercased prefix before the first slash", () => {
  expect(pageNamespace("AWS/EC2")).toBe("aws");
  expect(pageNamespace("Claude/Code Review")).toBe("claude");
  expect(pageNamespace("Project/Data Centre")).toBe("project");
});

test("only the first segment counts for nested titles", () => {
  expect(pageNamespace("AWS/EC2/Spot")).toBe("aws");
});

test("titles without a slash have no namespace", () => {
  expect(pageNamespace("AWS")).toBeUndefined();
  expect(pageNamespace("Project Management")).toBeUndefined();
});

test("a slash with nothing usable before it is not a namespace", () => {
  expect(pageNamespace("/etc/hosts")).toBeUndefined();
  expect(pageNamespace("  /x")).toBeUndefined();
});

test("surrounding whitespace on the prefix is ignored", () => {
  expect(pageNamespace("UoS /Strategy")).toBe("uos");
});
