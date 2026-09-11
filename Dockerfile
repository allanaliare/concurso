FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/concurso.sqlite

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["npm", "start"]
