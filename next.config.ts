import type { NextConfig } from "next";

const DW_URL = "https://ebs-dw.vercel.app";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/dw",        destination: `${DW_URL}/dw` },
      { source: "/dw/:path*", destination: `${DW_URL}/dw/:path*` },
      { source: "/api/dw/:path*",               destination: `${DW_URL}/api/dw/:path*` },
      { source: "/api/etl/:path*",              destination: `${DW_URL}/api/etl/:path*` },
      { source: "/api/concurrent-requests",     destination: `${DW_URL}/api/concurrent-requests` },
      { source: "/concurrent-requests",         destination: `${DW_URL}/concurrent-requests` },
      { source: "/concurrent-requests/:path*",  destination: `${DW_URL}/concurrent-requests/:path*` },
    ];
  },
};

export default nextConfig;
