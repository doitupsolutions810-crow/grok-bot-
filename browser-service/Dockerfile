# Shared browser computer: the Playwright image ships the browsers but not the
# `playwright` npm package, so computer.js could never require it at boot.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /app
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.64.1
