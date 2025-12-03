# 9oormthon-3 Backend

Backend API 서버 (Node.js/Express)

## 구조

```
/
├── Dockerfile          # Docker 이미지 빌드 파일
├── package.json       # Node.js 의존성
├── server.js          # Express 서버 코드
├── k8s/                # Kubernetes 배포 설정
│   ├── backend.yaml    # Backend Deployment & Service
│   ├── ingress.yaml    # Ingress 설정
│   ├── kustomization.yaml
│   ├── mysql-secret.yaml
│   ├── mysql/          # MySQL 데이터베이스 설정
│   └── config/         # ConfigMap 설정
└── .gitignore
```

## 빌드

```bash
docker build -t backend:latest .
```

## 실행

```bash
docker run -p 8080:8080 backend:latest
```

## 환경 변수

- `DB_HOST`: MySQL 호스트
- `DB_PORT`: MySQL 포트 (기본값: 3306)
- `DB_USER`: MySQL 사용자
- `DB_PASSWORD`: MySQL 비밀번호
- `DB_NAME`: MySQL 데이터베이스 이름

## Kubernetes 배포

### ArgoCD 사용

```bash
kubectl apply -f argocd/applications/backend-app.yaml
```

### Kustomize 사용

```bash
kubectl apply -k k8s/
```

## 관련 저장소

- **Frontend**: `9oormthon-3-frontend` - Frontend 소스 코드 및 배포 설정

