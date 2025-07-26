# Stage 1: Building the application
# We use node:18-alpine because it's a lightweight Linux distribution
FROM node:18.19.0-alpine AS builder

# Set the working directory inside the container
WORKDIR /app

# Copy package files first (this helps with Docker layer caching)
# If package.json hasn't changed, Docker can reuse this layer
COPY package*.json ./

# Copy Prisma schema for database setup
COPY prisma ./prisma/

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy all source code
COPY . .

# Generate Prisma client (this creates the database query code)
RUN npx prisma generate

# Build the NestJS application
RUN npm run build

# Stage 2: Running the application
# We create a smaller image for production by only copying what we need
FROM node:18-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nestjs -u 1001

# Set working directory
WORKDIR /app

# Copy only production dependencies and built files from builder stage
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./

# Switch to non-root user
USER nestjs

# Expose the port your app runs on
EXPOSE 3000

# Use dumb-init to start the app (handles signals properly)
ENTRYPOINT ["dumb-init", "--"]

# Run migrations and start the application
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
