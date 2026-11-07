FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 UPLOAD_DIR=/app/data/uploads
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data/uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
