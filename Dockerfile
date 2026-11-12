# Playwright image includes Chromium + system deps needed to bypass Cloudflare pages
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.mjs ./

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "index.mjs"]
