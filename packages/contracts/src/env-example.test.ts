import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ENV_SHAPE } from "./app-config";
import { renderEnvExample } from "./env-example";
import { envKeyMeta } from "./env-meta";

describe(".env.example", () => {
  it("documents every schema key through .meta()", () => {
    for (const [key, schema] of Object.entries(APP_ENV_SHAPE)) {
      expect(envKeyMeta(schema), key).toMatchObject({ section: expect.any(String) });
    }
  });

  it("lists every schema key exactly once", () => {
    const rendered = renderEnvExample();
    for (const key of Object.keys(APP_ENV_SHAPE)) {
      expect(rendered.match(new RegExp(`^(# )?${key}=`, "gm")), key).toHaveLength(1);
    }
  });

  it("matches the committed file (regenerate with `pnpm env:example`)", () => {
    const committed = readFileSync(resolve(__dirname, "../../../.env.example"), "utf-8");
    expect(committed).toBe(renderEnvExample());
  });
});
