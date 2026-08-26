import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FusionSourceBar } from "./FusionSourceBar";

describe("FusionSourceBar", () => {
  it("only links to currently available sources and states unavailable or deleted source health", () => {
    render(
      <MemoryRouter>
        <FusionSourceBar sources={[
          { nodeId: "available-source", bodyVersionId: "body-available", fragmentId: "fragment-available", label: "可用来源", health: "available" },
          { nodeId: "trashed-source", bodyVersionId: "body-trashed", fragmentId: "fragment-trashed", label: "回收站来源", health: "temporarily-unavailable" },
          { nodeId: "deleted-source", bodyVersionId: "body-deleted", fragmentId: "fragment-deleted", label: "已删来源", health: "deleted" },
        ]} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "可用来源" })).toHaveAttribute("href", "/nodes/available-source");
    expect(screen.getByText("来源暂不可用：回收站来源")).toBeInTheDocument();
    expect(screen.getByText("来源已永久删除：已删来源")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "回收站来源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "已删来源" })).not.toBeInTheDocument();
  });
});
