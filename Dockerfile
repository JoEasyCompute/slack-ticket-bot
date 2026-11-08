FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
RUN mkdir /app/data && chown node:node /app/data
USER node
CMD ["npm", "run", "start:server"]
