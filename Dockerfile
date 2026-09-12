# Production Dockerfile for Real-Time Collaborative Canvas
FROM node:20-alpine AS builder

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY client/ ./client/
COPY server/ ./server/

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Security: Run as non-root node user
USER node

COPY --chown=node:node --from=builder /app ./

EXPOSE 3000

# Health check to ensure server responds
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "server/server.js"]
