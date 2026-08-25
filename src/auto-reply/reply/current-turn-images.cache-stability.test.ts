import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";

const PNG_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_IMAGE_BYTES = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

describe("current-turn image cache stability", () => {
  it("dedupes the same image arriving through prepared and attachment paths", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-duplicate-image-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, PNG_IMAGE_BYTES);
      const inlineImage = {
        type: "image" as const,
        data: PNG_IMAGE_BYTES.toString("base64"),
        mimeType: "image/png",
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "describe this image",
          media: [
            {
              path: imagePath,
              contentType: "image/png",
              kind: "image",
              workspaceDir: base,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        images: [inlineImage],
      });

      expect(result.images).toEqual([inlineImage]);
      expect(result.imageOrder).toEqual(["inline"]);
      expect(result.imageSourceIndexes).toEqual([undefined]);
    });
  });

  it("preserves genuinely different images across current-turn paths", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-distinct-images-" }, async (base) => {
      const imagePath = path.join(base, "second.jpg");
      await fs.writeFile(imagePath, JPEG_IMAGE_BYTES);
      const inlineImage = {
        type: "image" as const,
        data: PNG_IMAGE_BYTES.toString("base64"),
        mimeType: "image/png",
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "compare these images",
          media: [
            {
              path: imagePath,
              contentType: "image/jpeg",
              kind: "image",
              workspaceDir: base,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        images: [inlineImage],
      });

      expect(result.images).toHaveLength(2);
      expect(result.images?.[0]).toEqual(inlineImage);
      expect(result.images?.[1]?.data).toBe(JPEG_IMAGE_BYTES.toString("base64"));
      expect(result.images?.[1]?.mimeType).toBe("image/jpeg");
      expect(result.imageOrder).toEqual(["inline", "inline"]);
    });
  });
});
