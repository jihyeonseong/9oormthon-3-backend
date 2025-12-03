pipeline {
    agent {
        kubernetes {
            yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: jnlp
    image: jenkins/inbound-agent:latest
    args: ['\$(JENKINS_SECRET)', '\$(JENKINS_NAME)']
  - name: docker
    image: docker:latest
    command:
    - sleep
    args:
    - 99d
    volumeMounts:
    - name: docker-sock
      mountPath: /var/run/docker.sock
  - name: kubectl
    image: bitnami/kubectl:latest
    command:
    - sleep
    args:
    - 99d
  - name: aws
    image: amazon/aws-cli:latest
    command:
    - sleep
    args:
    - 99d
  volumes:
  - name: docker-sock
    hostPath:
      path: /var/run/docker.sock
"""
        }
    }
    
    environment {
        AWS_REGION = 'ap-northeast-2'
        AWS_ACCOUNT_ID = '837126493345'
        ECR_REGISTRY = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
        IMAGE_NAME = 'goormthon-3/backend'
        IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_COMMIT.take(7)}"
        FULL_IMAGE = "${ECR_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
        LATEST_IMAGE = "${ECR_REGISTRY}/${IMAGE_NAME}:latest"
        NAMESPACE = 'goormthon-3'
    }
    
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        
        stage('Build Docker Image') {
            steps {
                container('docker') {
                    script {
                        sh """
                            docker build -t ${FULL_IMAGE} .
                            docker tag ${FULL_IMAGE} ${LATEST_IMAGE}
                        """
                    }
                }
            }
        }
        
        
        stage('Login to ECR') {
            steps {
                container('docker') {
                    script {
                        sh """
                            apk add --no-cache aws-cli || true
                            aws ecr get-login-password --region ${AWS_REGION} | \
                            docker login --username AWS --password-stdin ${ECR_REGISTRY}
                        """
                    }
                }
            }
        }
        
        stage('Push to ECR') {
            steps {
                container('docker') {
                    script {
                        sh """
                            docker push ${FULL_IMAGE}
                            docker push ${LATEST_IMAGE}
                        """
                    }
                }
            }
        }
        
        stage('Update K8s Manifest') {
            steps {
                script {
                    dir('k8s') {
                        sh """
                            # 이미지 태그 업데이트
                            sed -i.bak 's|image:.*backend:.*|image: ${FULL_IMAGE}|g' backend.yaml
                            rm -f backend.yaml.bak
                            
                            # Git에 커밋 및 푸시 (선택사항)
                            # git config user.name "Jenkins"
                            # git config user.email "jenkins@example.com"
                            # git add backend.yaml
                            # git commit -m "Update backend image to ${IMAGE_TAG}" || true
                            # git push origin HEAD:${env.BRANCH_NAME} || true
                        """
                    }
                }
            }
        }
        
        stage('Trigger ArgoCD Sync') {
            steps {
                script {
                    // ArgoCD CLI를 사용하여 동기화 (또는 ArgoCD API 호출)
                    sh """
                        # ArgoCD CLI가 설치되어 있다면
                        # argocd app sync backend-app -n argocd || true
                        
                        # 또는 kubectl을 통해 ArgoCD Application을 업데이트
                        # kubectl patch application backend-app -n argocd --type merge -p '{\"operation\":{\"initiatedBy\":{\"username\":\"jenkins\"},\"sync\":{\"revision\":\"HEAD\"}}}' || true
                    """
                }
            }
        }
    }
    
    post {
        success {
            echo "Backend image ${FULL_IMAGE} built and pushed successfully"
        }
        failure {
            echo "Pipeline failed. Check logs for details."
        }
        always {
            script {
                try {
                    container('docker') {
                        sh 'docker system prune -f || true'
                    }
                } catch (Exception e) {
                    echo "Cleanup failed: ${e.getMessage()}"
                }
            }
        }
    }
}

