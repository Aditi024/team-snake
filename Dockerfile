# Team Snake — minimal Node 20 image for Fly.io.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

# Install production deps first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app.
COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
