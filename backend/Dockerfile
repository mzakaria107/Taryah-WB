FROM node:20-alpine AS base
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "src/index.js"]
