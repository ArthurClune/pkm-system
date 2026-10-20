// The namespace of a page title is the prefix before its first "/" --
// [[AWS/EC2]] is in "aws". Used to colour refs by tree.
import { expect, test } from "vitest";
import { pageNamespace } from "./pageNamespace";
import { rawTitleOf } from "../test-helpers";

test("returns the lowercased prefix before the first slash", () => {
  expect(pageNamespace(rawTitleOf("AWS/EC2"))).toBe("aws");
  expect(pageNamespace(rawTitleOf("Claude/Code Review"))).toBe("claude");
  expect(pageNamespace(rawTitleOf("Project/Data Centre"))).toBe("project");
});

test("only the first segment counts for nested titles", () => {
  expect(pageNamespace(rawTitleOf("AWS/EC2/Spot"))).toBe("aws");
});

test("titles without a slash have no namespace", () => {
  expect(pageNamespace(rawTitleOf("AWS"))).toBeUndefined();
  expect(pageNamespace(rawTitleOf("Project Management"))).toBeUndefined();
});

test("a slash with nothing usable before it is not a namespace", () => {
  expect(pageNamespace(rawTitleOf("/etc/hosts"))).toBeUndefined();
  expect(pageNamespace(rawTitleOf("  /x"))).toBeUndefined();
});

test("surrounding whitespace on the prefix is ignored", () => {
  expect(pageNamespace(rawTitleOf("UoS /Strategy"))).toBe("uos");
});
