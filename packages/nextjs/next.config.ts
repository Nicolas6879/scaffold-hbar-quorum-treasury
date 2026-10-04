import { existsSync, readFileSync } from "fs";
import type { NextConfig } from "next";
import path from "path";

// One .env.local at the repo root serves the CLI scripts and the dashboard alike. Next only reads
// env files from this package (and caches that load), so copy the public NEXT_PUBLIC_* values here.
const rootEnv = path.join(__dirname, "../../.env.local");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split(/\r?\n/)) {
    const match = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  // @sh/treasury ships TypeScript source shared with the CLI scripts.
  transpilePackages: ["@sh/treasury"],
  // Inline the public settings loaded from the root .env.local (Next only reads its own folder by default).
  env: {
    NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "",
    NEXT_PUBLIC_TREASURY_ID: process.env.NEXT_PUBLIC_TREASURY_ID ?? "",
  },
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: (config, { dev }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    if (dev) {
      config.watchOptions = {
        followSymlinks: true,
      };
      config.snapshot = { ...(config.snapshot as object), managedPaths: [] };
    }
    return config;
  },
};

module.exports = nextConfig;
