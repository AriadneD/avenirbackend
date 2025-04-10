# Use the official Node.js image
FROM node:18

# Install GraphicsMagick and Ghostscript (needed for gm/pdf2pic)
RUN apt-get update && \
    apt-get install -y graphicsmagick ghostscript && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy all remaining source files
COPY . .

# Expose port your app runs on
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]
