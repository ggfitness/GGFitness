# Imagen liviana de Node, sin dependencias nativas => build rápido y económico
FROM node:20-slim

WORKDIR /app

# Instalamos dependencias primero para aprovechar la cache de Docker
COPY package.json ./
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . .

# Carpeta de datos persistente (base JSON)
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
