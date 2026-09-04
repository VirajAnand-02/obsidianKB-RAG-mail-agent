import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // js-tiktoken ships large rank tables that should not be bundled.
  serverExternalPackages: ["js-tiktoken"],

  // Prompts are read from disk at runtime, so they are not statically
  // discoverable by the bundler. Force them into the serverless output or every
  // agent call fails with "Prompt not found" in production.
  outputFileTracingIncludes: {
    "/api/**/*": ["./src/prompts/**/*.md", "./src/evaluator/prompts/**/*.md"],
    "/dashboard/**/*": ["./src/prompts/**/*.md"],
  },

  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
