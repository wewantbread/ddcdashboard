import { describe, expect, it } from "vitest";
import { normalizeBrowserFormFields } from "./form-fields.js";

describe("normalizeBrowserFormFields", () => {
  it.each(["Ada", 7, false, ""])("keeps the supported value %j", (value) => {
    expect(normalizeBrowserFormFields([{ ref: "e1", value }])).toEqual([
      { ref: "e1", type: "text", value },
    ]);
  });

  it.each([
    [{ ref: "e1", text: "Neo" }, 'unsupported field key "text"'],
    [{ value: "Ada" }, "must include ref"],
    [{ ref: "e1" }, 'must include value; use value: "" to clear a field'],
    [{ ref: "e1", value: ["Neo"] }, "value must be a string, number, or boolean"],
    [{ ref: "e1", value: null }, "value must be a string, number, or boolean"],
  ])("rejects an invalid field with its index", (field, message) => {
    expect(() => normalizeBrowserFormFields([{ ref: "e0", value: "valid" }, field])).toThrow(
      `fields[1] ${message}`,
    );
  });
});
