import { describe, expect, it } from "vitest";
import { applyOps, buildTree, diffModels, ROOT, type Model, type Op } from "./model.ts";

const folder = (id: string, parent = ROOT, pos = "a0"): Op => ({
  id,
  set: { parent, pos, title: id, url: null, deleted: false },
});
const titles = (model: Model) => buildTree(model).children.map((c) => [c.title, c.children.map((g) => g.title)]);

describe("applyOps", () => {
  it("drops a move that would put a folder inside its own descendant", () => {
    const model: Model = new Map();
    applyOps(model, [folder("A"), folder("B", "A")]);
    applyOps(model, [{ id: "A", set: { parent: "B", pos: "a1", title: "A2" } }]);

    expect(model.get("A")).toMatchObject({ parent: ROOT, pos: "a0", title: "A2" });
    expect(titles(model)).toEqual([["A2", ["B"]]]);
  });

  it("keeps deletes sticky across later edits", () => {
    const model: Model = new Map();
    applyOps(model, [folder("A"), { id: "A", set: { deleted: true } }, { id: "A", set: { title: "edited" } }]);
    expect(buildTree(model).children).toEqual([]);
  });

  it("hides children of a deleted folder", () => {
    const model: Model = new Map();
    applyOps(model, [folder("A"), folder("B", "A"), { id: "A", set: { deleted: true } }]);
    expect(buildTree(model).children).toEqual([]);
  });
});

describe("diffModels", () => {
  it("restores swapped nesting without dropping moves as cycles", () => {
    const target: Model = new Map();
    applyOps(target, [folder("A"), folder("B", "A")]);
    const current: Model = new Map(target);
    applyOps(current, [
      { id: "B", set: { parent: ROOT } },
      { id: "A", set: { parent: "B" } },
      folder("C"),
    ]);
    expect(titles(current)).toEqual([["B", ["A"]], ["C", []]]);

    applyOps(current, diffModels(current, target));
    expect(titles(current)).toEqual([["A", ["B"]]]);
  });
});
