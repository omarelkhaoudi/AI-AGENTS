# The H-KIDS cockpit as one image: the Node server, its frontend and the Prisma
# migrations. Customer data never enters the image: generated documents, the
# catalogue and the conversations live in volumes (see deploy/).
FROM node:24-bookworm-slim

# Liberation Sans is metric-compatible with Arial, the face the H-KIDS
# documents were designed in; the PDF renderer finds it by its usual path.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-liberation openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# Development dependencies included: the Prisma CLI applies the migrations at
# start-up.
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx prisma generate \
  && mkdir -p data assets/documents/generated archive \
  && chown -R node:node /app

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000

# Migrations are additive and idempotent: applying them at every start keeps the
# database in step with the code that is about to run.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
