-- Static DB 초기화 스크립트 --
CREATE DATABASE IF NOT EXISTS mydb;
USE mydb;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL UNIQUE COMMENT '고유 사용자 ID (이름+랜덤번호)',
    name VARCHAR(50) NOT NULL COMMENT '이름',
    age INT COMMENT '나이',
    gender VARCHAR(10) COMMENT '성별',
    email VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
);

-- 초기 정적 데이터 삽입 (user_id 수동 생성 - 중복 체크 후 삽입)
-- 각 user_id는 이름 + 랜덤 번호(10-99)로 구성되며, 중복 시 4자리 번호 사용

-- 홍길동
INSERT INTO users (user_id, name, age, gender, email) 
SELECT '홍길동23', '홍길동', 25, '남', 'hong@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = '홍길동23');

INSERT INTO users (user_id, name, age, gender, email) 
SELECT '홍길동45', '홍길동', 25, '남', 'hong@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = '홍길동45')
AND NOT EXISTS (SELECT 1 FROM users WHERE name = '홍길동' AND age = 25 AND gender = '남');

-- 김철수
INSERT INTO users (user_id, name, age, gender, email) 
SELECT '김철수67', '김철수', 30, '남', 'kim@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = '김철수67');

-- 이영희
INSERT INTO users (user_id, name, age, gender, email) 
SELECT '이영희89', '이영희', 28, '여', 'lee@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = '이영희89');

-- 박민수
INSERT INTO users (user_id, name, age, gender, email) 
SELECT '박민수12', '박민수', 32, '남', 'park@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = '박민수12');

-- 최지영
INSERT INTO users (user_id, name, age, gender, email) 
SELECT '최지영34', '최지영', 26, '여', 'choi@example.com'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = '최지영34');

-- 사용자 권한 설정
GRANT ALL PRIVILEGES ON mydb.* TO 'myuser'@'%' IDENTIFIED BY 'mypassword';

-- 읽기 전용 사용자 생성 (선택사항 - static DB 읽기 전용 접근용)
CREATE USER IF NOT EXISTS 'readonly'@'%' IDENTIFIED BY 'readonly123';
GRANT SELECT ON mydb.* TO 'readonly'@'%';

FLUSH PRIVILEGES;

-- Static DB 확인용 쿼리
SELECT 'Static DB initialized with sample data' AS status;
SELECT COUNT(*) AS total_users FROM users;