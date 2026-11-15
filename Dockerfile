FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY db ./db
EXPOSE 3000
CMD ["sh","-c","node src/migrate.js && node src/seed.js && node src/index.js"]
