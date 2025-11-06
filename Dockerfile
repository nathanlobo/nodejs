# Start from an official Node.js 18 image
FROM node:18-slim

# Set non-interactive to avoid prompts during build
ENV DEBIAN_FRONTEND=noninteractive

# Set the working directory inside the container
WORKDIR /app

# Install build tools and clean up in one layer to reduce image size
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    g++ \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Give the 'node' user ownership of the /app directory
RUN chown -R node:node /app

# Switch back to the non-root 'node' user for security
USER node

# Copy package files first for better layer caching
COPY --chown=node:node package*.json ./

# Install production dependencies using npm ci for deterministic builds
RUN npm ci --only=production

# Copy the rest of your app's code (server.js, index.html, id-map.json)
COPY --chown=node:node . .

# Expose port 3000
EXPOSE 3000

# Health check to ensure the server is running
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/mapping', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# The command to start your server
CMD ["node", "server.js"]