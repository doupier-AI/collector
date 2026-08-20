import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { makeSelection } from "../../test/fakes";
import { SelectionSourceBar } from "./SelectionSourceBar";

function RouteStateProbe() {
  const location = useLocation();
  return <output>{JSON.stringify(location.state)}</output>;
}

describe("SelectionSourceBar", () => {
  it("返回消息原文时继续携带地图返回现场", async () => {
    const mapReturn = {
      version: 1 as const,
      sourceHistoryIndex: 0,
      sourceEntryKey: "map-entry",
      sourcePath: "/map/focus/source-node",
    };
    const selection = makeSelection({
      id: "selection-1",
      sessionId: "session-1",
      anchor: { kind: "message", messageId: "message-1", blockOrdinal: 0, startOffset: 0, endOffset: 2, exact: "原文" },
    });
    render(
      <MemoryRouter initialEntries={[{ pathname: "/nodes/child", state: { mapReturn } }]}>
        <Routes>
          <Route path="/nodes/child" element={<SelectionSourceBar sourceName="来源" selection={selection} />} />
          <Route path="/nodes/session-1" element={<RouteStateProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.setup().click(screen.getByRole("link", { name: "← 返回原文" }));
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ mapReturn }));
  });
});
