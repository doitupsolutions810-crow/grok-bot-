FROM mcr.microsoft.com/playwright:v1.64.1-jammy

# The upstream image ships browser binaries and system libraries, but not
# the Playwright Node package. Install the exact matching package at build
# time so the sidecar never reaches npm at runtime.
WORKDIR /app
RUN npm init -y \
    && npm install --omit=dev --save-exact playwright@1.64.1
COPY browser-service/computer.js /app/computer.js

CMD ["node", "/app/computer.js"]
