-- 지역 기반 퀘스트 문제 데이터
-- 이 파일은 별도로 마운트하거나 init.sql에 포함시킬 수 있습니다

USE mydb;

-- 퀘스트 문제 테이블
CREATE TABLE IF NOT EXISTS quests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    city VARCHAR(50) NOT NULL COMMENT '시/도 (예: Jeju, Seogwipo)',
    town VARCHAR(50) COMMENT '읍/면/동 (예: Aewol, Gujwa, Seogwi, Seongsan)',
    village VARCHAR(50) COMMENT '리/동 (예: Woljeong, Sehwa, Seongsan)',
    question TEXT NOT NULL COMMENT '질문',
    option_a VARCHAR(255) NOT NULL COMMENT '선택지 A',
    option_b VARCHAR(255) NOT NULL COMMENT '선택지 B',
    option_c VARCHAR(255) NOT NULL COMMENT '선택지 C',
    option_d VARCHAR(255) NOT NULL COMMENT '선택지 D',
    correct_answer CHAR(1) NOT NULL COMMENT '정답 (A, B, C, D 중 하나)',
    score INT NOT NULL DEFAULT 1 COMMENT '문제 점수 (맞추면 획득하는 점수)',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_city (city),
    INDEX idx_town (town),
    INDEX idx_village (village),
    INDEX idx_full_region (city, town, village)
) COMMENT='지역 기반 퀘스트 문제 테이블';

-- 사용자별 퀘스트 풀이 기록 테이블 (한 번 기록되면 변경되지 않음)
CREATE TABLE IF NOT EXISTS user_quest_scores (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL COMMENT '사용자 ID (users.user_id 참조, 예: 지현23)',
    quest_id INT NOT NULL COMMENT '퀘스트 ID (quests 테이블 참조)',
    answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '문제 푼 시간',
    city VARCHAR(50) NOT NULL COMMENT '문제 푼 지역 - 시/도',
    town VARCHAR(50) COMMENT '문제 푼 지역 - 읍/면/동',
    village VARCHAR(50) COMMENT '문제 푼 지역 - 리/동',
    question TEXT NOT NULL COMMENT '푼 문제',
    user_answer CHAR(1) NOT NULL COMMENT '사용자가 제출한 정답 (A, B, C, D)',
    correct_answer CHAR(1) NOT NULL COMMENT '실제 정답 (A, B, C, D)',
    score INT NOT NULL DEFAULT 0 COMMENT '획득한 점수 (맞췄으면 1점, 틀렸으면 0점)',
    INDEX idx_user_id (user_id),
    INDEX idx_quest_id (quest_id),
    INDEX idx_user_quest (user_id, quest_id),
    INDEX idx_answered_at (answered_at),
    INDEX idx_region (city, town, village),
    UNIQUE KEY unique_user_quest (user_id, quest_id) COMMENT '사용자당 같은 문제는 한 번만 기록',
    FOREIGN KEY (quest_id) REFERENCES quests(id) ON DELETE CASCADE
) COMMENT='사용자별 퀘스트 풀이 기록 테이블 (변경 불가)';

-- 지역 기반 퀘스트 문제 데이터
-- 1. Jeju Aewol Woljeong
INSERT INTO quests (city, town, village, question, option_a, option_b, option_c, option_d, correct_answer, score) VALUES
    ('Jeju', 'Aewol', 'Woljeong', 'Woljeong가 \'카페 성지\'로 불리는 가장 큰 이유는?', 
     '해안도로가 잘 정비되어 있다', 
     '에메랄드빛 바다가 보이는 카페들이 밀집해 있다', 
     '대형 쇼핑몰이 많다', 
     '밤문화가 유명하다', 
     'B', 1),
    ('Jeju', 'Aewol', 'Woljeong', 'Woljeong에서 조용히 바다를 감상하기 좋은 위치는?',
     '중심 교차로',
     '북쪽 항구',
     '주요 카페 라인에서 조금 벗어난 동쪽 구간',
     '해녀박물관 앞',
     'C', 1),
    ('Jeju', 'Aewol', 'Woljeong', 'Woljeong 바다가 유난히 에메랄드색을 띠는 이유는?',
     '조류가 강해서',
     '흰 모래·얕은 수심·현무암 지형이 빛 반사를 돕기 때문',
     '인공 조명이 설치되어 있어서',
     '바닷속에 산호가 많아서',
     'B', 1),
    ('Jeju', 'Aewol', 'Woljeong', 'Woljeong에서 인기 있는 액티비티는?',
     '패러글라이딩',
     '승마 체험',
     '패들보드와 스노클링',
     'ATV 사막 투어',
     'C', 1),
    ('Jeju', 'Aewol', 'Woljeong', 'Woljeong가 청년층에게 특히 인기 있는 이유는?',
     '대형 리조트가 많아서',
     '전통 사찰이 많아서',
     '감성 카페·편집숍·사진 스팟 등이 풍부해서',
     '농업 체험이 다양해서',
     'C', 1),

-- 2. Jeju Gujwa Sehwa
    ('Jeju', 'Gujwa', 'Sehwa', 'Sehwa가 \'예술 감성 마을\'로 불리는 이유는?',
     '대형 영화관이 많아서',
     '예술가·창작자의 공방과 갤러리가 많아서',
     '전통 시장이 없어서',
     '유명한 카지노가 있어서',
     'B', 1),
    ('Jeju', 'Gujwa', 'Sehwa', 'Sehwa에서 로컬 경험을 원할 때 방문하기 좋은 곳은?',
     '국제공항',
     '세화오일장(5일장)',
     '고속버스터미널',
     '잠수함 관광센터',
     'B', 1),
    ('Jeju', 'Gujwa', 'Sehwa', 'Sehwa 해안 분위기의 특징은?',
     'Woljeong보다 더 상업적이다',
     '조용하고 예술적인 감성이 강하다',
     '고층 호텔이 많다',
     '어촌 체험만 가능한 지역이다',
     'B', 1),
    ('Jeju', 'Gujwa', 'Sehwa', 'Sehwa 청년 문화의 대표 특징은?',
     '관광버스 관광이 활발하다',
     '이주 청년 창작자들의 커뮤니티 활동이 활발하다',
     '유명 체육관이 많다',
     '레저 스포츠 중심 지역이다',
     'B', 1),
    ('Jeju', 'Gujwa', 'Sehwa', 'Sehwa에서 자연 풍경을 즐기기 좋은 방법은?',
     '대형 쇼핑몰 산책',
     '해안도로를 따라 평대–세화 구간 걷기',
     '케이블카 탑승',
     '산속 온천 방문',
     'B', 1)

-- 3. Seogwipo Seogwi
    ('Seogwipo', 'Seogwi', NULL, 'Seogwi의 대표 명소는 무엇일까?',
     '용머리해안',
     '이중섭거리와 정방폭포',
     '한라산 백록담',
     'Woljeong 해변',
     'B', 1)
    ('Seogwipo', 'Seogwi', NULL, '이중섭 거리에서 할 수 있는 경험은?',
     '해양 스포츠 체험',
     '갤러리·공방 방문과 고유의 예술 분위기 감상',
     '산악 등반',
     '대형 콘서트 관람',
     'B', 1)
    ('Seogwipo', 'Seogwi', NULL, '정방폭포가 특별한 이유는?',
     '제주의 가장 높은 폭포라서',
     '물이 바다로 직접 떨어지는 국내 유일의 폭포라서',
     '온천수가 흘러서',
     '야생 말이 서식해서',
     'B', 1)
    ('Seogwipo', 'Seogwi', NULL, 'Seogwi 거리 분위기는 어떤가?',
     '전통 농촌 마을 분위기',
     '시장·카페·갤러리가 섞인 작은 해안 도시 분위기',
     '공업 단지 중심',
     '고층 빌딩 중심',
     'B', 1)
    ('Seogwipo', 'Seogwi', NULL, 'Seogwi에서 로컬 음식을 한 번에 즐기기 좋은 장소는?',
     '제주공항 면세구역',
     '서귀포매일올레시장',
     '성산항 어시장',
     '한림항 수산센터',
     'B', 1)

-- 4. Seogwipo Seongsan Seongsan
    ('Seogwipo', 'Seongsan', 'Seongsan', 'Seongsan가 유명한 가장 큰 이유는?',
     '제주 최대 쇼핑센터가 위치해서',
     '성산일출봉이 있기 때문',
     '의료 관광지라서',
     '제주 최대 골프장이 있어서',
     'B', 1)
    ('Seogwipo', 'Seongsan', 'Seongsan', '성산일출봉을 가장 잘 즐기는 방법은?',
     '일몰 시간에만 방문하기',
     '일출 30~40분 전에 정상에 도착해 해돋이를 감상하기',
     '해변에서 멀리서 바라보기만 하기',
     '밤에 등산하기',
     'B', 1)
    ('Seogwipo', 'Seongsan', 'Seongsan', 'Seongsan 주변 바다 풍경의 특징은?',
     '산호초가 많이 보인다',
     '고층 건물과 함께 도시적 경관을 이룬다',
     '현무암 지형과 넓은 수평선이 어우러진 웅장한 풍경',
     '모래사장이 거의 없다',
     'C', 1)
    ('Seogwipo', 'Seongsan', 'Seongsan', 'Seongsan에서 즐기기 좋은 식도락 경험은?',
     '전복·해산물 요리와 함께 감성 카페 즐기기',
     '양고기 전문점 투어',
     '유명한 와인 농장 방문',
     '초콜릿 공장 탐방',
     'A', 1)
    ('Seogwipo', 'Seongsan', 'Seongsan', 'Seongsan에서 걷기 좋은 코스는?',
     '중문 단지 산책로',
     '한라산 동릉 코스',
     '성산일출봉 아래 해안 산책로 및 섭지코지 방문 산책',
     '도두봉 등반',
     'C', 1)
ON DUPLICATE KEY UPDATE question=question;

