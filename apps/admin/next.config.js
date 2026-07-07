/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@tvwatch/shared'],
};
module.exports = nextConfig;