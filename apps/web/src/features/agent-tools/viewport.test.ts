import { expect, test } from "bun:test";
import { CARD_MAX_HEIGHT, cardLayout, fitView, readableScale, similarSize, zoomAt } from "./viewport";

test("the readable floor follows the drawing's typical text size", () => {
  expect(readableScale("<svg><style>#m{font-size:16px}</style></svg>")).toBeCloseTo(11 / 16);
  expect(readableScale('<svg><text font-size="22">a</text><text font-size="22">b</text><text font-size="8">c</text></svg>')).toBeCloseTo(0.5);
  expect(readableScale("<svg><path d='M0 0'/></svg>")).toBeCloseTo(11 / 16);
  expect(readableScale('<svg><text font-size="4">tiny</text></svg>')).toBe(2);
});

test("a card shows a small drawing at natural size, centred", () => {
  const { view, height, clipped } = cardLayout({ width: 200, height: 100 }, 600, 0.7);
  expect(view).toEqual({ scale: 1, x: 200, y: 0 });
  expect(height).toBe(100);
  expect(clipped).toBe(false);
});

test("a card shrinks a slightly wide drawing to fit, while it stays readable", () => {
  const { view, clipped } = cardLayout({ width: 800, height: 300 }, 600, 0.7);
  expect(view.scale).toBe(0.75);
  expect(clipped).toBe(false);
});

test("a card never shrinks a wide drawing below readable: it clips and says so", () => {
  const { view, height, clipped } = cardLayout({ width: 3000, height: 400 }, 600, 11 / 16);
  expect(view.scale).toBeCloseTo(11 / 16);
  expect(view.x).toBe(0);
  expect(height).toBe(Math.ceil(400 * (11 / 16)));
  expect(clipped).toBe(true);
});

test("a tall drawing is capped in the card and clipped", () => {
  const { height, clipped } = cardLayout({ width: 300, height: 2000 }, 600, 0.7);
  expect(height).toBe(CARD_MAX_HEIGHT);
  expect(clipped).toBe(true);
});

test("the panel fits and centres, enlarging a small drawing only so far", () => {
  const wide = fitView({ width: 2000, height: 500 }, { width: 1048, height: 800 });
  expect(wide.scale).toBeCloseTo(0.5);
  expect(wide.x).toBeCloseTo(24);
  expect(wide.y).toBeCloseTo((800 - 250) / 2);
  expect(fitView({ width: 40, height: 40 }, { width: 1000, height: 1000 }).scale).toBe(3);
});

test("zooming keeps the point under the pointer still", () => {
  const before = { scale: 1, x: 10, y: 20 };
  const after = zoomAt(before, 2, { x: 110, y: 70 });
  expect(after.scale).toBe(2);
  expect((110 - after.x) / after.scale).toBeCloseTo((110 - before.x) / before.scale);
  expect((70 - after.y) / after.scale).toBeCloseTo((70 - before.y) / before.scale);
});

test("a version of about the same size keeps the zoom; a very different one refits", () => {
  expect(similarSize({ width: 800, height: 400 }, { width: 860, height: 420 })).toBe(true);
  expect(similarSize({ width: 800, height: 400 }, { width: 1600, height: 400 })).toBe(false);
});
