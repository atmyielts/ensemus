/* global module */
// Next.js lists Playwright as an optional peer, and pnpm fills an optional peer from anywhere in the
// workspace. That would put a test tool in the web app's production tree, and so in the image build.
// Playwright is only ever a dev dependency of tests/browser, so Next.js does not get to see it.
function readPackage(pkg) {
  if (pkg.name === 'next') {
    delete pkg.peerDependencies?.['@playwright/test'];
    delete pkg.peerDependenciesMeta?.['@playwright/test'];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
