import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  },
  // Next.js 16 uses Turbopack by default
  turbopack: {
    resolveAlias: {
      // web-tree-sitter conditionally imports Node-only modules;
      // stub them out for browser bundles so the bundler can resolve them.
      "fs/promises": { browser: "./src/lib/fs-browser-stub.ts" },
      module: { browser: "./src/lib/fs-browser-stub.ts" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Disable Node-only packages for the browser bundle
      config.resolve.alias = {
        ...config.resolve.alias,
        "onnxruntime-node$": false,
        "sharp$": false,
      };
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
      };
    }
    // Allow .wasm files to be imported
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};

export default nextConfig;
