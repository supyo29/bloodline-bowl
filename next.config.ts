import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This project sits under a parent directory that also has a lockfile; pin the
  // tracing root so Next does not infer the wrong workspace.
  outputFileTracingRoot: path.join(import.meta.dirname, "."),
  // Phase 3.5C: the analytical evidence route reads the immutable history store, the surface registry and the
  // served intelligence artifacts by dynamic path; make sure the deployment bundle carries them.
  // The MCP endpoint's conventional public path. Same handler, same proxy policy (proxy.ts maps /mcp -> /api/mcp).
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
  outputFileTracingIncludes: {
    // /api/mcp invokes the evidence and intelligence route handlers in-process, so it needs the same data files.
    "/api/mcp": [
      "./data/intelligence-history/**/*",
      "./docs/intelligence-surface-registry.json",
      "./lib/football-intel/data/**/*",
      "./lib/player-role-intelligence/data/**/*",
      "./lib/opportunity-propagation-intelligence/data/**/*",
      "./lib/player-scheme-intelligence/data/**/*",
    ],
    "/api/evidence": [
      "./data/intelligence-history/**/*",
      "./docs/intelligence-surface-registry.json",
      "./lib/football-intel/data/**/*",
      "./lib/player-role-intelligence/data/**/*",
      "./lib/opportunity-propagation-intelligence/data/**/*",
      "./lib/player-scheme-intelligence/data/**/*",
    ],
    // W2.P2: the Role Shadow capture job reads the committed Role inputs (and the propagation model) by dynamic path.
    "/api/cron/role-shadow-capture": ["./lib/role-calibration/data/**/*", "./lib/opportunity-propagation-intelligence/data/**/*"],
  },
};

export default nextConfig;
