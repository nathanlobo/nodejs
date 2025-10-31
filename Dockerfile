# Start from an official Node.js 18 image
FROM node:18-slim

# Set the working directory inside the container
WORKDIR /app

# Install the g++ compiler
# We run as 'root' just for this step
USER root
RUN apt-get update && apt-get install g++ -y

# Switch back to the non-root 'node' user for security
USER node

# Copy the package.json and package-lock.json
COPY --chown=node:node package*.json ./

# Install npm dependencies
RUN npm install

# Copy the rest of your app's code (server.js, .cpp, .html)
COPY --chown=node:node . .

# Tell Render that your app runs on port 3000
EXPOSE 3000

# The command to start your server
CMD ["node", "server.js"]