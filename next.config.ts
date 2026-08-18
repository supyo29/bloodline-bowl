import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This project sits under a parent directory that also has a lockfile; pin the
  // tracing root so Next does not infer the wrong workspace.
  outputFileTracingRoot: path.join(import.meta.dirname, "."),
};

export default nextConfig;
