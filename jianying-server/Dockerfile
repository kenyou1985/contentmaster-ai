FROM node:20-bookworm-slim

# 安装 Python3 + ffmpeg（剪映导出脚本所需）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       python3-pip \
       ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先安装依赖以利用 Docker 层缓存
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝服务代码
COPY . .

ENV NODE_ENV=production
ENV PYTHON_BIN=python3

EXPOSE 8080

CMD ["node", "server.mjs"]
