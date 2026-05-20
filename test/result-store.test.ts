import { describe, it, expect, vi, afterEach } from "vitest";
import { ResultStore } from "../src/result-store.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ResultStore", () => {
  it("stores and retrieves content by handle", () => {
    const store = new ResultStore();
    const handle = store.put("hello world");
    expect(store.get(handle)).toBe("hello world");
  });

  it("returns undefined for an unknown handle", () => {
    expect(new ResultStore().get("res_999")).toBeUndefined();
  });

  it("issues distinct handles", () => {
    const store = new ResultStore();
    expect(store.put("a")).not.toBe(store.put("b"));
  });

  it("pages content with slice and reports nextOffset", () => {
    const store = new ResultStore();
    const handle = store.put("0123456789");
    const first = store.slice(handle, 0, 4);
    expect(first).toEqual({
      text: "0123",
      offset: 0,
      nextOffset: 4,
      total: 10,
    });
    const last = store.slice(handle, 8, 4);
    expect(last).toEqual({
      text: "89",
      offset: 8,
      nextOffset: null,
      total: 10,
    });
  });

  it("returns undefined when slicing an unknown handle", () => {
    expect(new ResultStore().slice("res_404")).toBeUndefined();
  });

  it("evicts entries older than the TTL", () => {
    vi.useFakeTimers();
    const store = new ResultStore(1000);
    const handle = store.put("temporary");
    vi.advanceTimersByTime(1500);
    expect(store.get(handle)).toBeUndefined();
  });

  it("drops the oldest entry when maxEntries is exceeded", () => {
    const store = new ResultStore(60_000, 2);
    const first = store.put("one");
    store.put("two");
    store.put("three");
    expect(store.get(first)).toBeUndefined();
    expect(store.size).toBe(2);
  });
});
