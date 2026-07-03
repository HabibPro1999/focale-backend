// @app/source first (workspace source). require/node before import so CJS-only deps resolve to their CJS entry.
const conditions = ["@app/source", "require", "node", "default"];

/** Shared resolve block for all four vitest tiers. */
export const resolveConditions = {
  resolve: { conditions },
  ssr: { resolve: { conditions } },
};
