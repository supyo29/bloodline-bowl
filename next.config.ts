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
  outputFileTracingIncludes: {
    "/api/evidence": [
      "./data/intelligence-history/**/*",
      "./docs/intelligence-surface-registry.json",
      "./lib/football-intel/data/**/*",
      "./lib/player-role-intelligence/data/**/*",
      "./lib/opportunity-propagation-intelligence/data/**/*",
      "./lib/player-scheme-intelligence/data/**/*",
    ],
  },
};

export default nextConfig;
