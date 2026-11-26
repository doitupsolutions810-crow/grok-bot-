# The Playwright base image ships browsers and system deps but NOT the playwright npm
# package, so `require("playwright")` in computer.js failed (MODULE_NOT_FOUND) and the
# browser container restart-looped; the boot then timed out waiting for browser:3000.
# Install the library at the SAME version as the image so it finds the bundled browsers.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.64.1 && node -e "require('playwright')"
COPY computer.js /app/computer.js
CMD ["node", "/app/computer.js"]
