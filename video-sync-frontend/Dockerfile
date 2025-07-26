# Stage 1: Building the React application
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy all source files
COPY . .

# Build the React app for production
# This creates an optimized build in the 'build' folder
RUN npm run build

# Stage 2: Serving the application
# We use nginx to serve our static React files
FROM nginx:alpine

# Copy our custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the built React app from the builder stage
# The React build output goes to /usr/share/nginx/html (nginx's default web root)
COPY --from=builder /app/build /usr/share/nginx/html

# Expose port 80 (standard HTTP port)
EXPOSE 80

# Start nginx in the foreground (important for Docker)
CMD ["nginx", "-g", "daemon off;"]
