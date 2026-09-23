import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A local production phone smoke can build while the development server stays
  // up; Vercel expects the default `.next`.
  distDir: process.env.NODE_ENV === "production" && !process.env.VERCEL ? ".next-production" : ".next",
  // Admit only the configured mini-app tunnel to development assets/HMR.
  ...(process.env.PUBLIC_WEB_URL ? { allowedDevOrigins: [new URL(process.env.PUBLIC_WEB_URL).hostname] } : {}),
  // Workspace packages and the partner SDK are TypeScript sources; Next compiles them.
  transpilePackages: ["@aomi-telegram/core", "@aomi-telegram/tenant-world", "@wcm-inc/sdk", "@wcm-inc/abi", "@wcm-inc/tools"],
  serverExternalPackages: ["postgres", "ethers", "undici"],
};

export default nextConfig;
