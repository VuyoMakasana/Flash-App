# ─────────────────────────────────────────────────────────────────────────────
# Flash Backend — Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# This builds a production-ready Docker image of the Flash backend.
# It is used by docker-compose.yml when you run the full stack locally,
# and by Render/Railway/Fly.io when you deploy to production.
#
# To build and run manually (without docker compose):
#   docker build -t flash-backend .
#   docker run -p 3000:3000 --env-file .env flash-backend
# ─────────────────────────────────────────────────────────────────────────────

# Use Node.js 20 on Alpine Linux (small, secure base image)
FROM node:20-alpine

# Install dumb-init so Node.js shuts down cleanly when Docker stops the container.
# Without this, SIGTERM is not forwarded properly and the process force-kills.
RUN apk add --no-cache dumb-init

# Set the working directory inside the container
WORKDIR /app

# Copy package files first (before the rest of the code).
# Docker caches this layer — npm install only re-runs when package.json changes,
# not every time you change a source file. This makes builds much faster.
COPY package*.json ./

# Install only production dependencies (skip devDependencies like nodemon)
RUN npm ci --only=production

# Copy the rest of the backend source code
COPY . .

# The backend listens on port 3000
EXPOSE 3000

# Mark the container healthy only when the API health endpoint responds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "require('http').get('http://127.0.0.1:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Use dumb-init as the process manager so signals (SIGTERM) work correctly.
# This ensures graceful shutdown (draining DB connections) works as intended.
CMD ["dumb-init", "node", "server.js"]
