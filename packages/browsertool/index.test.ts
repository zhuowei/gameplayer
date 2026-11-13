import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./index";

describe("browsertool CLI arg parsing", () => {
  test("parses command, positionals, and flags cleanly", () => {
    const parsed = parseCliArgs([
      "drive",
      "--ms",
      "3500",
      "--out=/tmp/sheet.jpg",
      "--match",
      "jane.local",
    ]);
    expect(parsed.cmd).toBe("drive");
    expect(parsed.flags.ms).toBe("3500");
    expect(parsed.flags.out).toBe("/tmp/sheet.jpg");
    expect(parsed.flags.match).toBe("jane.local");
  });

  test("parses run positional JS body with boolean flags", () => {
    const parsed = parseCliArgs([
      "run",
      "await api.tapButton(1, 100)",
      "--label",
      "fire",
      "--help",
    ]);
    expect(parsed.cmd).toBe("run");
    expect(parsed.positionals).toEqual(["await api.tapButton(1, 100)"]);
    expect(parsed.flags.label).toBe("fire");
    expect(parsed.flags.help).toBe(true);
  });
});
