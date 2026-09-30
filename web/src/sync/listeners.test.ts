import { describe, expect, it, vi } from "vitest";
import { listeners } from "./listeners";

describe("listeners", () => {
  it("emits to every listener", () => {
    const set = listeners<number>();
    const a = vi.fn();
    const b = vi.fn();
    set.add(a);
    set.add(b);
    set.emit(3);
    expect(a).toHaveBeenCalledWith(3);
    expect(b).toHaveBeenCalledWith(3);
  });

  it("add returns an unsubscribe", () => {
    const set = listeners<number>();
    const fn = vi.fn();
    const off = set.add(fn);
    off();
    set.emit(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a throwing listener does not stop the others", () => {
    const set = listeners<string>();
    const after = vi.fn();
    set.add(() => { throw new Error("boom"); });
    set.add(after);
    expect(() => set.emit("x")).not.toThrow();
    expect(after).toHaveBeenCalledWith("x");
  });
});
