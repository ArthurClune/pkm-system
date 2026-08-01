import { fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { expect, it } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "./router";
import { useRouteTitle } from "./useRouteTitle";

function Probe() {
  useRouteTitle();
  const navigate = useNavigate();
  return <button onClick={() => navigate("/settings")}>go to settings</button>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
      <Probe />
    </MemoryRouter>,
  );
}

it.each([
  ["/", "Daily Notes — pkm"],
  ["/current-work", "Current Work — pkm"],
  ["/help", "Keyboard shortcuts — pkm"],
  ["/files", "Files — pkm"],
  ["/settings", "Settings — pkm"],
])("sets the browser title for %s", (path, expected) => {
  renderAt(path);
  expect(document.title).toBe(expected);
});

it("leaves the title alone on /page/* -- PageView sets its own once the page's title loads", () => {
  document.title = "Machine Learning — pkm";
  renderAt("/page/Machine%20Learning");
  expect(document.title).toBe("Machine Learning — pkm");
});

it("leaves the title alone on an unmatched route, matching the prior not-found behaviour", () => {
  document.title = "Daily Notes — pkm";
  renderAt("/definitely/not/a/route");
  expect(document.title).toBe("Daily Notes — pkm");
});

it("updates the title again on navigation between static routes", () => {
  const { getByRole } = renderAt("/");
  expect(document.title).toBe("Daily Notes — pkm");

  fireEvent.click(getByRole("button", { name: "go to settings" }));
  expect(document.title).toBe("Settings — pkm");
});
