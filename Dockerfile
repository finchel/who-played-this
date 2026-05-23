FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Cloud Run injects PORT (default 8080); server.js already reads process.env.PORT
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
