import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 uses Turbopack by default
  turbopack: {},
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Disable Node-only packages for the browser bundle
      config.resolve.alias = {
        ...config.resolve.alias,
        "onnxruntime-node$": false,
        "sharp$": false,
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
