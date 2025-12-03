FROM node:18-alpine

WORKDIR /app

# package.json 복사
COPY package*.json ./

# 의존성 설치
RUN npm install --production

# 소스 코드 복사
COPY . .

# 포트 노출
EXPOSE 8080

# 애플리케이션 실행
CMD ["node", "server.js"]

