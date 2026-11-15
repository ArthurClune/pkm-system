import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { lazyLoader, useLazy, type Loader } from "./lazyComponent";

function Probe({ load, seen }: { load: Loader<string>; seen: string[] }) {
  const state = useLazy(load);
  seen.push(state.status);
  return <span>{state.status === "ok" ? state.value : state.status}</span>;
}

describe("lazyLoader", () => {
  it("loads once and peeks the value only once it has resolved", async () => {
    const load = vi.fn(() => Promise.resolve("chunk"));
    const loader = lazyLoader(load);
    expect(loader.peek()).toBeUndefined();
    await Promise.all([loader(), loader()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(loader.peek()).toBe("chunk");
  });

  it("forgets a failed load, so the next call retries", async () => {
    const load = vi.fn()
      .mockReturnValueOnce(Promise.reject(new Error("offline")))
      .mockReturnValueOnce(Promise.resolve("chunk"));
    const loader = lazyLoader<string>(load);
    await expect(loader()).rejects.toThrow("offline");
    expect(loader.peek()).toBeUndefined();
    await expect(loader()).resolves.toBe("chunk");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("useLazy", () => {
  it("a mount after the load has resolved renders the value on its first render", async () => {
    const loader = lazyLoader(() => Promise.resolve("chunk"));
    const first: string[] = [];
    const view = render(<Probe load={loader} seen={first} />);
    expect(await screen.findByText("chunk")).toBeInTheDocument();
    expect(first[0]).toBe("loading");
    view.unmount();

    const second: string[] = [];
    render(<Probe load={loader} seen={second} />);
    expect(second[0]).toBe("ok");
    expect(second).not.toContain("loading");
  });

  it("reports a failed load", async () => {
    const loader = lazyLoader(() => Promise.reject(new Error("offline")));
    render(<Probe load={loader as Loader<string>} seen={[]} />);
    expect(await screen.findByText("error")).toBeInTheDocument();
  });
});
