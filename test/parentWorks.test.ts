import { describe, it, expect } from "vitest";
import { shapeWork } from "../src/shape";

// oxjob #2065: a work names the works it is part of (parent_works) and counts the works that are part of it
// (child_works_count). Both show in list and full records, and only when there is something to show.

describe("parent and child works in a work record", () => {
  const chapter = {
    id: "https://openalex.org/W1", display_name: "A chapter", type: "book-chapter",
    parent_works: [{ id: "https://openalex.org/W3109397498", display_name: "A handbook", relationship: "volume" }],
    child_works_count: 0,
  };
  it("lists parents with short ids, titles and relationships", () => {
    expect(shapeWork(chapter).parent_works).toEqual([{ id: "W3109397498", title: "A handbook", relationship: "volume" }]);
    expect(shapeWork(chapter, { full: true }).parent_works).toEqual([{ id: "W3109397498", title: "A handbook", relationship: "volume" }]);
  });
  it("leaves both out when the work has no parent and no child", () => {
    const plain = shapeWork({ id: "https://openalex.org/W2", display_name: "A paper", parent_works: [], child_works_count: 0 });
    expect(plain).not.toHaveProperty("parent_works");
    expect(plain).not.toHaveProperty("child_works_count");
    expect(shapeWork(chapter)).not.toHaveProperty("child_works_count");
  });
  it("counts a book's parts", () => {
    expect(shapeWork({ id: "https://openalex.org/W3109397498", display_name: "A handbook", child_works_count: 44 }).child_works_count).toBe(44);
  });
});
