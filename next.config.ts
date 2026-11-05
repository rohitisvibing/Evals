import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The golden set is read at runtime by the benchmark pages/export.
  outputFileTracingIncludes: {
    "/benchmark": ["./data/golden/**/*"],
    "/api/benchmark/export": ["./data/golden/**/*"],
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
