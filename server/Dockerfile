FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
# Installs devDependencies too (nodemon); compose runs `npm run dev`.
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
