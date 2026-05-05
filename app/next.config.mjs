import { createRequire } from "module";
const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        os: false,
        path: false,
        crypto: false,
      };
      const { ProvidePlugin } = require("webpack");
      config.plugins.push(new ProvidePlugin({ Buffer: ["buffer", "Buffer"] }));
    }
    return config;
  },
};

export default nextConfig;
