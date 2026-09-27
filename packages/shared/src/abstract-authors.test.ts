import { expect, it } from "vitest";
import { getAbstractTitle } from "./abstract-authors";

it.each([null, undefined, [], "title", {}, { title: 42 }, { title: "" }, { title: "   " }])(
  "uses the display fallback for %j", content => {
    expect(getAbstractTitle(content)).toBe("Untitled abstract");
  },
);

it("trims a non-empty title without altering its contents", () => {
  expect(getAbstractTitle({ title: "  An abstract\nwith two lines  " }))
    .toBe("An abstract\nwith two lines");
});
