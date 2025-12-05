const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// 모든 요청 로깅 (디버깅용)
app.use((req, res, next) => {
  // POST 요청과 /quests 관련 요청 모두 로깅
  if (req.method === 'POST' || req.path.includes('/quests') || req.path.includes('/check')) {
    console.log(`[요청 로그] ${req.method} ${req.path}`, {
      params: req.params,
      body: req.body,
      query: req.query,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent']
      }
    });
  }
  next();
});

// MySQL 연결 풀 생성
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'myuser',
  password: process.env.DB_PASSWORD || 'mypass123',
  database: process.env.DB_NAME || 'mydb',
  charset: 'utf8mb4', // UTF-8 완전 지원 (이모지 포함)
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// AWS S3 클라이언트 초기화
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  },
  // 리전별 엔드포인트 명시적 설정
  endpoint: `https://s3.${process.env.AWS_REGION || 'ap-northeast-2'}.amazonaws.com`,
  forcePathStyle: false // virtual-hosted-style 사용
});

const S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || '';

// 지역명 영어->한국어 변환 맵
const regionNameMap = {
  // City (시/도)
  'Jeju': '제주시',
  'Seogwipo': '서귀포시',
  // Town (읍/면/동)
  'Aewol': '애월읍',
  'Gujwa': '구좌읍',
  'Seogwi': '서귀동',
  'Seongsan': '성산읍', // town인 경우
  // Village (리/동)
  'Woljeong': '월정리',
  'Sehwa': '세화리'
};

// 지역명 변환 함수
// type: 'city' | 'town' | 'village'
function translateRegionName(englishName, type = null) {
  if (!englishName) return englishName;
  
  // Seongsan은 타입에 따라 다르게 변환
  if (englishName === 'Seongsan') {
    if (type === 'village') return '성산리';
    return '성산읍'; // town인 경우
  }
  
  return regionNameMap[englishName] || englishName;
}

// S3 이미지 파일 목록 캐시 (성능 최적화)
let seongsanImageCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5분 캐시

// S3에서 성산 이미지 파일 목록 가져오기 (캐싱)
async function getSeongsanImageList() {
  const now = Date.now();
  
  // 캐시가 유효하면 재사용
  if (seongsanImageCache && (now - cacheTimestamp) < CACHE_TTL) {
    return seongsanImageCache;
  }
  
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      Prefix: 'uploads/'
    });
    
    const listResponse = await s3Client.send(listCommand);
    const files = (listResponse.Contents || [])
      .map(item => item.Key)
      .filter(key => {
        // 성산으로 시작하고 .jpeg로 끝나는 파일만
        const fileName = key.split('/').pop(); // 파일명만 추출
        return fileName && fileName.startsWith('성산') && fileName.endsWith('.jpeg');
      })
      .sort(); // 정렬하여 순서 보장
    
    // 캐시 업데이트
    seongsanImageCache = files;
    cacheTimestamp = now;
    
    return files;
  } catch (error) {
    console.error('[getSeongsanImageList] Error:', error);
    return [];
  }
}

// S3 이미지 Presigned URL 생성 함수
// 성산0.jpeg, 성산1.jpeg, 성산2.jpeg만 불러오기 (questId와 관계없이)
// Private 버킷이므로 Presigned URL 사용
// 매번 호출 시 새로운 Presigned URL 생성 (만료 방지)
async function getSeongsanImageUrl(index) {
  if (!S3_BUCKET_NAME) {
    console.warn(`[getSeongsanImageUrl] S3_BUCKET_NAME is not set`);
    return null;
  }
  
  // 성산0, 성산1, 성산2만 (index 0, 1, 2만)
  if (index < 0 || index > 2) {
    console.warn(`[getSeongsanImageUrl] Invalid index: ${index}`);
    return null;
  }
  
  try {
    // S3 파일명 직접 사용 (실제 파일명: seongsan0.jpeg, seongsan1.jpeg, seongsan2.jpeg)
    const fileName = `seongsan${index}.jpeg`;
    const imageKey = `uploads/${fileName}`;
    
    console.log(`[getSeongsanImageUrl] Generating Presigned URL for index ${index}, key: ${imageKey}`);
    
    // 파일 존재 여부 확인 (NoSuchKey 방지)
    try {
      const headCommand = new HeadObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: imageKey
      });
      await s3Client.send(headCommand);
      console.log(`[getSeongsanImageUrl] File exists: ${imageKey}`);
    } catch (headError) {
      if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
        console.error(`[getSeongsanImageUrl] File not found in S3: ${imageKey}`);
        return null;
      }
      // 다른 에러는 무시하고 Presigned URL 생성 시도
      console.warn(`[getSeongsanImageUrl] HeadObject check failed (continuing): ${headError.message}`);
    }
    
    // Presigned URL 생성 (5분 유효) - 매번 새로 생성하여 만료 방지
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: imageKey
    });
    
    const url = await getSignedUrl(s3Client, command, { 
      expiresIn: 300 // 5분 (URL에서 확인한 값과 동일)
    });
    
    console.log(`[getSeongsanImageUrl] Successfully generated Presigned URL for index ${index}, expires in 5 minutes`);
    return url;
  } catch (error) {
    // 상세한 에러 정보 로깅
    console.error(`[getSeongsanImageUrl] Error for index ${index}:`, {
      name: error.name,
      message: error.message,
      code: error.Code || error.code,
      statusCode: error.$metadata?.httpStatusCode,
      stack: error.stack
    });
    return null;
  }
}

// Multer 설정 (메모리 스토리지 - 파일을 메모리에 저장)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB 제한
  },
  fileFilter: (req, file, cb) => {
    console.log(`[Multer] 파일 필터 - fieldname: ${file.fieldname}, originalname: ${file.originalname}, mimetype: ${file.mimetype}`);
    cb(null, true);
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// DB 연결 테스트
app.get('/api/health/db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.json({ message: 'Database connection successful', status: 'ok' });
  } catch (error) {
    res.status(500).json({ message: 'Database connection failed', error: error.message });
  }
});

// 모든 사용자 조회
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, user_id, name, age, gender, email, created_at FROM users ORDER BY id DESC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: error.message });
  }
});

// user_id로 사용자 조회
app.get('/api/users/by-id/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const [rows] = await pool.execute('SELECT id, user_id, name, age, gender, email, created_at FROM users WHERE user_id = ?', [user_id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching user by user_id:', error);
    res.status(500).json({ error: error.message });
  }
});

// 사용자 생성 (POST - 클러스터 내부/기타 클라이언트용)
app.post('/api/users', async (req, res) => {
  try {
    const { name, age, gender, email } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    // user_id 생성 (중복 체크 포함)
    let user_id;
    let attempts = 0;
    const maxAttempts = 100;
    
    do {
      const randomNum = Math.floor(10 + Math.random() * 90); // 10~99
      user_id = `${name}${randomNum}`;
      
      const [existing] = await pool.execute(
        'SELECT COUNT(*) as count FROM users WHERE user_id = ?',
        [user_id]
      );
      
      if (existing[0].count === 0) {
        break; // 중복 없음
      }
      
      attempts++;
      
      // 100번 시도 후에도 중복이면 4자리 번호 사용
      if (attempts >= maxAttempts) {
        const randomNum4 = Math.floor(1000 + Math.random() * 9000);
        user_id = `${name}${randomNum4}`;
        break;
      }
    } while (attempts < maxAttempts);
    
    const [result] = await pool.execute(
      'INSERT INTO users (user_id, name, age, gender, email) VALUES (?, ?, ?, ?, ?)',
      [user_id, name, age || null, gender || null, email || null]
    );
    
    res.json({ 
      id: result.insertId, 
      user_id: user_id,
      name, 
      age, 
      gender, 
      email 
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: error.message });
  }
});

// 사용자 생성 (GET - 브라우저에서 POST가 막힌 환경 우회용)
// 예: GET /api/users/create?name=지현&age=25&gender=여
app.get('/api/users/create', async (req, res) => {
  try {
    const { name, age, gender, email } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    // user_id 생성 (중복 체크 포함)
    let user_id;
    let attempts = 0;
    const maxAttempts = 100;
    
    do {
      const randomNum = Math.floor(10 + Math.random() * 90); // 10~99
      user_id = `${name}${randomNum}`;
      
      const [existing] = await pool.execute(
        'SELECT COUNT(*) as count FROM users WHERE user_id = ?',
        [user_id]
      );
      
      if (existing[0].count === 0) {
        break; // 중복 없음
      }
      
      attempts++;
      
      // 100번 시도 후에도 중복이면 4자리 번호 사용
      if (attempts >= maxAttempts) {
        const randomNum4 = Math.floor(1000 + Math.random() * 9000);
        user_id = `${name}${randomNum4}`;
        break;
      }
    } while (attempts < maxAttempts);
    
    const [result] = await pool.execute(
      'INSERT INTO users (user_id, name, age, gender, email) VALUES (?, ?, ?, ?, ?)',
      [user_id, name, age || null, gender || null, email || null]
    );
    
    res.json({ 
      id: result.insertId, 
      user_id: user_id,
      name, 
      age, 
      gender, 
      email 
    });
  } catch (error) {
    console.error('Error creating user via GET /api/users/create:', error);
    res.status(500).json({ error: error.message });
  }
});

// 사용자 삭제
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: error.message });
  }
});

// 지역별 랜덤 퀘스트 조회 (사진 찍기 또는 문제 풀기 랜덤 선택)
app.get('/api/quests/random', async (req, res) => {
  try {
    // Express는 쿼리 파라미터를 자동으로 디코딩하지만,
    // 일부 프록시/인그레스에서 이중 인코딩이 될 수 있으므로 안전하게 처리
    let city = req.query.city;
    let town = req.query.town;
    let village = req.query.village;
    
    // %가 포함되어 있으면 아직 인코딩된 상태이므로 디코딩 시도
    if (city && typeof city === 'string' && city.includes('%')) {
      try {
        city = decodeURIComponent(city);
      } catch (e) {
        console.warn('Failed to decode city:', city, e);
      }
    }
    if (town && typeof town === 'string' && town.includes('%')) {
      try {
        town = decodeURIComponent(town);
      } catch (e) {
        console.warn('Failed to decode town:', town, e);
      }
    }
    if (village && typeof village === 'string' && village.includes('%')) {
      try {
        village = decodeURIComponent(village);
      } catch (e) {
        console.warn('Failed to decode village:', village, e);
      }
    }
    
    // 최소한 city는 필요
    if (!city) {
      return res.status(400).json({ error: 'City parameter is required' });
    }
    
    console.log('Quest search params (processed):', { city, town, village });
    
    // 50:50 확률로 타입 먼저 선택
    const questType = Math.random() < 0.5 ? 'photo' : 'question';
    console.log(`[랜덤 퀘스트] 선택된 타입: ${questType}`);
    
    // 선택된 타입에 맞는 quest 조회
    // 1단계: 타입 필터링
    let query = 'SELECT * FROM quests WHERE city = ?';
    let params = [city];
    
    // 타입에 따라 필터링 (먼저 타입으로 필터링)
    if (questType === 'photo') {
      query += ' AND option_a = ?';
      params.push('사진 미션');
    } else {
      query += ' AND option_a != ?';
      params.push('사진 미션');
    }
    
    // 2단계: 지역 조건 추가 (town/village가 제공되면 정확히 일치하는 것만, 없으면 모든 것 포함)
    if (town) {
      query += ' AND town = ?';
      params.push(town);
    }
    
    if (village) {
      query += ' AND village = ?';
      params.push(village);
    }
    
    // 3단계: 랜덤 선택
    query += ' ORDER BY RAND() LIMIT 1';
    
    console.log(`[랜덤 퀘스트] 쿼리: ${query}`, params);
    
    let [rows] = await pool.execute(query, params);
    
    // 선택된 타입의 quest가 없으면 반대 타입으로 fallback
    if (rows.length === 0) {
      console.log(`[랜덤 퀘스트] ${questType} 타입 quest를 찾을 수 없어 반대 타입으로 fallback`);
      const fallbackType = questType === 'photo' ? 'question' : 'photo';
      
      // Fallback: 반대 타입의 quest 조회
      query = 'SELECT * FROM quests WHERE city = ?';
      params = [city];
      
      // 타입 필터링
      if (fallbackType === 'photo') {
        query += ' AND option_a = ?';
        params.push('사진 미션');
      } else {
        query += ' AND option_a != ?';
        params.push('사진 미션');
      }
      
      // 지역 조건
      if (town) {
        query += ' AND town = ?';
        params.push(town);
      }
      
      if (village) {
        query += ' AND village = ?';
        params.push(village);
      }
      
      // 랜덤 선택
      query += ' ORDER BY RAND() LIMIT 1';
      
      console.log(`[랜덤 퀘스트] Fallback 쿼리: ${query}`, params);
      
      [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) {
      const [availableCities] = await pool.execute('SELECT DISTINCT city FROM quests');
      return res.status(404).json({ 
        error: `No quest found for region: ${city}${town ? ' ' + town : ''}${village ? ' ' + village : ''}`,
        availableCities: availableCities.map(r => r.city),
        receivedParams: { city, town, village }
      });
    }
    
      // fallback 타입으로 변경
      const finalType = fallbackType;
    const quest = rows[0];
      console.log(`[랜덤 퀘스트] Fallback quest ID: ${quest.id}, 타입: ${finalType}`);
    
      if (finalType === 'photo') {
    res.json({
          type: 'photo',
          id: quest.id,
          region: {
            city: quest.city,
            town: quest.town,
            village: quest.village
          },
          instruction: quest.question,
          locationHint: quest.question,
          uploadEndpoint: '/api/s3/upload',
          options: {},
          score: quest.score
        });
      } else {
        res.json({
          type: 'question',
      id: quest.id,
      region: {
        city: quest.city,
        town: quest.town,
        village: quest.village
      },
      question: quest.question,
      options: {
        A: quest.option_a,
        B: quest.option_b,
        C: quest.option_c,
        D: quest.option_d
      },
          score: quest.score
        });
      }
      return;
    }
    
    const quest = rows[0];
    console.log(`[랜덤 퀘스트] 선택된 quest ID: ${quest.id}, 타입: ${questType}`);
    
    if (questType === 'photo') {
      // 사진 찍는 퀘스트 응답 - 사진 업로드 엔드포인트로 리다이렉트
      res.json({
        type: 'photo',
        id: quest.id,
        region: {
          city: quest.city,
          town: quest.town,
          village: quest.village
        },
        instruction: quest.question, // DB에 저장된 사진 미션 지시사항 사용
        locationHint: quest.question, // 문제 질문을 장소 힌트로 사용
        uploadEndpoint: '/api/s3/upload', // 사진 업로드 엔드포인트
        options: {}, // 프론트엔드 호환성을 위해 빈 객체 (사진 찍는 퀘스트는 사용하지 않음)
        score: quest.score
      });
    } else {
      // 문제 푸는 퀘스트 응답
      res.json({
        type: 'question',
        id: quest.id,
        region: {
          city: quest.city,
          town: quest.town,
          village: quest.village
        },
        question: quest.question,
        options: {
          A: quest.option_a,
          B: quest.option_b,
          C: quest.option_c,
          D: quest.option_d
        },
        score: quest.score
      });
    }
  } catch (error) {
    console.error('Error fetching random quest:', error);
    res.status(500).json({ error: error.message });
  }
});

// 퀘스트 정답 확인 및 점수 기록
app.post('/api/quests/:id/check', async (req, res) => {
  console.log(`[퀘스트 정답 확인] ========== 엔드포인트 진입 ==========`);
  console.log(`[퀘스트 정답 확인] 요청 URL: ${req.url}`);
  console.log(`[퀘스트 정답 확인] 요청 Method: ${req.method}`);
  console.log(`[퀘스트 정답 확인] 요청 Path: ${req.path}`);
  console.log(`[퀘스트 정답 확인] 요청 Params:`, req.params);
  console.log(`[퀘스트 정답 확인] 요청 Body:`, req.body);
  console.log(`[퀘스트 정답 확인] 요청 Headers:`, {
    'content-type': req.headers['content-type'],
    'content-length': req.headers['content-length']
  });
  
  try {
    const { id } = req.params;
    const { answer, user_id } = req.body; // user_id는 user_id 필드 (예: "지현23")
    
    console.log(`[퀘스트 정답 확인] POST 요청 받음 - quest_id: ${id}, user_id: ${user_id || '없음'}, answer: ${answer || '없음'}`);
    console.log(`[퀘스트 정답 확인] 요청 body:`, JSON.stringify(req.body));
    
    // 파라미터 검증
    if (!answer) {
      console.warn(`[퀘스트 정답 확인] answer가 없음 - quest_id: ${id}`);
      return res.status(400).json({ error: 'Answer is required' });
    }
    
    if (!id) {
      console.warn(`[퀘스트 정답 확인] quest_id가 없음`);
      return res.status(400).json({ error: 'Quest ID is required' });
    }
    
    // 문제 전체 정보 조회 (정답 확인 페이지에 필요한 모든 정보)
    let questRows;
    try {
      [questRows] = await pool.execute(
        'SELECT * FROM quests WHERE id = ?',
        [id]
      );
    } catch (dbError) {
      console.error('Database connection error:', dbError);
      return res.status(503).json({ 
        error: 'Database connection failed', 
        message: 'MySQL 서버에 연결할 수 없습니다. DB 연결을 확인해주세요.',
        details: dbError.message 
      });
    }
    
    if (questRows.length === 0) {
      return res.status(404).json({ error: `Quest not found with id: ${id}` });
    }
    
    const quest = questRows[0];
    const isCorrect = quest.correct_answer.toUpperCase() === answer.toUpperCase();
    const finalScore = isCorrect ? 1 : 0; // 맞췄으면 1점, 틀렸으면 0점
    
    console.log(`[퀘스트 정답 확인] quest_id: ${id}, user_id: ${user_id || '없음'}, answer: ${answer}, correct: ${isCorrect}`);
    
    // 사용자 ID가 제공된 경우 풀이 기록 저장 (한 번 기록되면 변경되지 않음)
    if (user_id) {
      try {
        // 풀이 기록 저장 (ON DUPLICATE KEY UPDATE로 중복 방지, 한 번 기록되면 변경 안 됨)
        const [result] = await pool.execute(
          `INSERT INTO user_quest_scores 
           (user_id, quest_id, city, town, village, question, user_answer, correct_answer, score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             user_id = user_id`, // 중복 시 업데이트하지 않음 (한 번 기록되면 변경 안 됨)
          [
            user_id, 
            id, 
            quest.city, 
            quest.town, 
            quest.village, 
            quest.question,
            answer.toUpperCase(), 
            quest.correct_answer, 
            finalScore
          ]
        );
        
        if (result.affectedRows > 0) {
          console.log(`[퀘스트 정답 확인] 저장 성공 - user_id: ${user_id}, quest_id: ${id}, affectedRows: ${result.affectedRows}`);
        } else {
          console.log(`[퀘스트 정답 확인] 저장됨 (중복 또는 업데이트 없음) - user_id: ${user_id}, quest_id: ${id}`);
        }
      } catch (scoreError) {
        console.error('[퀘스트 정답 확인] 저장 실패:', {
          error: scoreError.message,
          stack: scoreError.stack,
          user_id: user_id,
          quest_id: id
        });
        // 기록 저장 실패해도 정답 확인은 진행
      }
    } else {
      console.warn(`[퀘스트 정답 확인] user_id가 없어서 저장하지 않음 - quest_id: ${id}`);
    }
    
    // 정답 확인 페이지에 필요한 모든 정보 반환
    res.json({
      id: quest.id,
      region: {
        city: quest.city,
        town: quest.town,
        village: quest.village
      },
      question: quest.question,
      options: {
        A: quest.option_a,
        B: quest.option_b,
        C: quest.option_c,
        D: quest.option_d
      },
      userAnswer: answer.toUpperCase(), // 사용자가 선택한 답
      correctAnswer: quest.correct_answer, // 실제 정답
      correct: isCorrect, // 정답 여부
      score: finalScore, // 맞췄으면 1점, 틀렸으면 0점
      questScore: quest.score // 문제 원래 점수 (참고용)
    });
  } catch (error) {
    console.error('Error checking quest answer:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// 지역별 모든 퀘스트 조회 (관리용)
app.get('/api/quests', async (req, res) => {
  try {
    const { city, town, village } = req.query;
    
    let query = 'SELECT id, city, town, village, question, option_a, option_b, option_c, option_d, correct_answer, score FROM quests WHERE 1=1';
    let params = [];
    
    if (city) {
      query += ' AND city = ?';
      params.push(city);
    }
    
    if (town) {
      query += ' AND town = ?';
      params.push(town);
    }
    
    if (village) {
      query += ' AND village = ?';
      params.push(village);
    }
    
    query += ' ORDER BY city, town, village, id';
    
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching quests:', error);
    res.status(500).json({ error: error.message });
  }
});

// 사용자별 총점 조회 (user_id로 조회)
app.get('/api/users/:user_id/score', async (req, res) => {
  try {
    const { user_id } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT 
        COALESCE(SUM(score), 0) as total_score,
        COUNT(*) as total_quests,
        SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) as correct_count,
        SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) as incorrect_count
       FROM user_quest_scores
       WHERE user_id = ?`,
      [user_id]
    );
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching user score:', error);
    res.status(500).json({ error: error.message });
  }
});

// 사용자별 퀘스트 기록 조회 (user_id로 조회)
app.get('/api/users/:user_id/quests', async (req, res) => {
  try {
    let { user_id } = req.params;
    
    // URL 디코딩 처리 (한글 user_id 지원)
    try {
      user_id = decodeURIComponent(user_id);
    } catch (e) {
      // 디코딩 실패 시 원본 사용
      console.warn('Failed to decode user_id:', user_id);
    }
    
    console.log(`[퀘스트 조회] user_id: ${user_id}`);
    console.log(`[퀘스트 조회] user_id (hex): ${Buffer.from(user_id, 'utf8').toString('hex')}`);
    
    // quest_id를 기반으로 quests 테이블과 JOIN하여 city, town, village 가져오기
    let [rows] = await pool.execute(
      `SELECT 
        uqs.id,
        uqs.user_id,
        uqs.quest_id,
        uqs.answered_at as '문제 푼 시간',
        COALESCE(q.city, uqs.city) as '시',
        COALESCE(q.town, uqs.town) as '동',
        COALESCE(q.village, uqs.village) as '리',
        uqs.question as '푼 문제',
        uqs.user_answer as '사용자가 제출한 정답',
        uqs.correct_answer as '실제 정답',
        uqs.score as '점수'
       FROM user_quest_scores uqs
       LEFT JOIN quests q ON uqs.quest_id = q.id
       WHERE uqs.user_id = ?
       ORDER BY uqs.answered_at DESC`,
      [user_id]
    );
    
    console.log(`[퀘스트 조회] 조회된 퀘스트 수: ${rows.length}개`);
    
    // 디버깅: 실제 DB 쿼리 결과 확인
    if (rows.length === 0) {
      console.warn(`[퀘스트 조회] 조회 결과가 0개입니다. 직접 쿼리로 확인합니다.`);
      try {
        const [debugRows] = await pool.execute(
          `SELECT id, user_id, quest_id FROM user_quest_scores WHERE user_id = ? LIMIT 5`,
          [user_id]
        );
        console.log(`[퀘스트 조회] 직접 쿼리 결과: ${debugRows.length}개`);
        if (debugRows.length > 0) {
          console.log(`[퀘스트 조회] 첫 번째 레코드:`, debugRows[0]);
        }
      } catch (debugError) {
        console.error(`[퀘스트 조회] 디버깅 쿼리 실패:`, debugError.message);
      }
    }
    
    // 디버깅: 조회된 퀘스트 정보 출력
    if (rows.length > 0) {
      console.log(`[퀘스트 조회] 첫 번째 퀘스트 샘플:`, {
        id: rows[0].id,
        quest_id: rows[0].quest_id,
        user_id: rows[0].user_id,
        question: rows[0]['푼 문제']?.substring(0, 50)
      });
    } else {
      console.warn(`[퀘스트 조회] user_id '${user_id}'에 대한 퀘스트 기록이 없습니다.`);
      
      // 디버깅: user_quest_scores 테이블에 데이터가 있는지 확인
      try {
        const [allScores] = await pool.execute('SELECT COUNT(*) as count FROM user_quest_scores');
        const [userScores] = await pool.execute('SELECT COUNT(*) as count FROM user_quest_scores WHERE user_id = ?', [user_id]);
        console.log(`[퀘스트 조회] 디버깅 - 전체 기록 수: ${allScores[0].count}, ${user_id} 기록 수: ${userScores[0].count}`);
      } catch (debugError) {
        console.error('[퀘스트 조회] 디버깅 쿼리 실패:', debugError.message);
      }
    }
    
    // 각 quest_id에 대해 user_upload_history에서 이미지 URL 조회
    // 업로드된 이미지가 없으면 기본 이미지(seongsan0, seongsan1, seongsan2) 사용
    const rowsWithImages = await Promise.all(
      rows.map(async (row, index) => {
        let imageUrl = null;
        
        // 1. 먼저 업로드된 이미지 조회 시도
        if (row.quest_id) {
          try {
            // quest_id로 업로드 히스토리 조회 (quest_id 컬럼이 있으면 사용, 없으면 다른 방법)
            const [uploadRows] = await pool.execute(
              `SELECT file_url, file_key FROM user_upload_history 
               WHERE user_id = ? AND quest_id = ? 
               ORDER BY uploaded_at DESC LIMIT 1`,
              [user_id, row.quest_id]
            );
            
            if (uploadRows.length > 0) {
              imageUrl = uploadRows[0].file_url;
            }
          } catch (uploadError) {
            // quest_id 컬럼이 없을 수 있으므로 에러 무시하고 계속 진행
            console.warn(`[퀘스트 조회] quest_id로 이미지 조회 실패 (quest_id 컬럼이 없을 수 있음): ${uploadError.message}`);
            
            // quest_id 없이 user_id만으로 조회 시도
            try {
              const [uploadRows] = await pool.execute(
                `SELECT file_url, file_key FROM user_upload_history 
                 WHERE user_id = ? 
                 ORDER BY uploaded_at DESC LIMIT 1`,
                [user_id]
              );
              
              if (uploadRows.length > 0) {
                imageUrl = uploadRows[0].file_url;
              }
            } catch (fallbackError) {
              console.warn(`[퀘스트 조회] fallback 이미지 조회 실패: ${fallbackError.message}`);
            }
          }
        }
        
        // 2. 업로드된 이미지가 없으면 기본 이미지 사용 (seongsan0, seongsan1, seongsan2)
        if (!imageUrl && index < 3) {
          imageUrl = await getSeongsanImageUrl(index);
        }
        
        return {
          ...row,
          '업로드된 이미지 URL': imageUrl
        };
      })
    );
    
    console.log(`[퀘스트 조회] 조회된 퀘스트 수: ${rows.length}개`);
    
    // 지역명을 한국어로 변환하고 이미지 URL 처리
    const translatedRows = await Promise.all(
      rowsWithImages.map(async (row) => {
        // 업로드된 이미지 URL이 있으면 사용, 없으면 null
        let imageUrl = row['업로드된 이미지 URL'] || null;
        
        // 업로드된 이미지가 있고 Presigned URL이 필요한 경우 (S3 private 버킷)
        if (imageUrl && imageUrl.includes('s3.ap-northeast-2.amazonaws.com')) {
          // file_key를 추출하여 Presigned URL 생성
          try {
            const fileKey = imageUrl.split('.s3.ap-northeast-2.amazonaws.com/')[1]?.split('?')[0];
            if (fileKey) {
              const command = new GetObjectCommand({
                Bucket: S3_BUCKET_NAME,
                Key: fileKey
              });
              imageUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
            }
          } catch (urlError) {
            console.warn(`[퀘스트 조회] Presigned URL 생성 실패: ${urlError.message}`);
            // 실패해도 원본 URL 사용
          }
        }
        
        console.log(`[퀘스트 조회] quest_id ${row.quest_id}, 이미지 URL: ${imageUrl ? '있음' : '없음'}`);
        
        // 응답 객체 생성 (내부 필드 제거)
        const responseRow = {
          id: row.id,
          user_id: row.user_id,
          quest_id: row.quest_id,
          '문제 푼 시간': row['문제 푼 시간'],
          '시': translateRegionName(row['시'], 'city'),
          '동': row['동'] ? translateRegionName(row['동'], 'town') : row['동'],
          '리': row['리'] ? translateRegionName(row['리'], 'village') : row['리'],
          '푼 문제': row['푼 문제'],
          '사용자가 제출한 정답': row['사용자가 제출한 정답'],
          '실제 정답': row['실제 정답'],
          '점수': row['점수'],
          '이미지 URL': imageUrl
        };
        
        return responseRow;
      })
    );
    
    console.log(`[퀘스트 조회] 최종 반환: ${translatedRows.length}개`);
    res.json(translatedRows);
  } catch (error) {
    console.error('Error fetching user quests:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 제주 버스 API 프록시 ====================

// 제주 버스 도착 정보 조회 (GET /api/bus/arrival)
app.get('/api/bus/arrival', async (req, res) => {
  try {
    const { station_id } = req.query;
    
    // 제주 버스 API 호출 (station_id가 있으면 쿼리 파라미터로 추가)
    let busApiUrl = 'https://bus.jeju.go.kr/api/searchArrivalInfoList.do';
    if (station_id) {
      busApiUrl += `?station_id=${station_id}`;
    }
    
    // https 모듈을 사용하여 외부 API 호출 (SSL 인증서 문제 해결)
    const https = require('https');
    const { URL } = require('url');
    
    const parsedUrl = new URL(busApiUrl);
    
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Node.js)',
          'Accept': 'application/json'
        },
        // SSL 인증서 검증 우회 (일부 외부 API에서 필요)
        rejectUnauthorized: false
      };
      
      const req = https.request(options, (response) => {
        let responseData = '';
        
        response.on('data', (chunk) => {
          responseData += chunk;
        });
        
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseData}`));
            return;
          }
          
          try {
            const jsonData = JSON.parse(responseData);
            resolve(jsonData);
          } catch (e) {
            reject(new Error('Failed to parse JSON: ' + e.message));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error('Request failed: ' + error.message));
      });
      
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.end();
    });
    
    res.json({
      success: true,
      station_id: station_id || null,
      data: data
    });
  } catch (error) {
    console.error('Bus API proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== AWS S3 API ====================

// 퀘스트 이미지 업로드 (POST /api/quests/:id/image)
// uploads 폴더에 저장: uploads/{quest_id}.{ext}
app.post('/api/quests/:id/image', upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    if (!S3_BUCKET_NAME) {
      return res.status(500).json({ error: 'S3 bucket not configured' });
    }

    // 파일 확장자 추출
    const originalName = req.file.originalname;
    const fileExtension = originalName.split('.').pop().toLowerCase() || 'jpg';
    
    // uploads 폴더에 저장: uploads/{quest_id}.{ext}
    const imageKey = `uploads/${id}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: imageKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    });

    await s3Client.send(command);

    // S3 URL 생성 (리전별 엔드포인트)
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const fileUrl = `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${imageKey}`;

    res.json({
      success: true,
      questId: id,
      imageKey: imageKey,
      url: fileUrl,
      size: req.file.size
    });
  } catch (error) {
    console.error('Quest image upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Multer 에러 핸들러 미들웨어
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error(`[Multer 에러] ${err.code}:`, err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'File too large',
        details: '파일 크기는 10MB를 초과할 수 없습니다.',
        maxSize: '10MB'
      });
    }
    return res.status(400).json({ 
      error: 'File upload error',
      details: err.message,
      code: err.code
    });
  }
  if (err) {
    console.error(`[업로드 에러]`, err);
    return res.status(500).json({ 
      error: 'Upload failed',
      details: err.message
    });
  }
  next();
};

// 파일 업로드 (POST /api/s3/upload)
// user_id를 받아서 사용자별 업로드 히스토리 저장
app.post('/api/s3/upload', upload.single('file'), handleMulterError, async (req, res) => {
  console.log(`[S3 업로드] ========== 요청 시작 ==========`);
  console.log(`[S3 업로드] 요청 URL: ${req.url}`);
  console.log(`[S3 업로드] 요청 Method: ${req.method}`);
  console.log(`[S3 업로드] 요청 Headers:`, {
    'content-type': req.headers['content-type'],
    'content-length': req.headers['content-length']
  });
  console.log(`[S3 업로드] 요청 Body (user_id, quest_id, fileName, folder):`, {
    user_id: req.body.user_id,
    quest_id: req.body.quest_id,
    fileName: req.body.fileName,
    folder: req.body.folder
  });
  console.log(`[S3 업로드] 파일 정보:`, {
    file: req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    } : '없음'
  });
  
  try {
    if (!req.file) {
      console.error(`[S3 업로드] 파일이 없음 - 요청 body:`, req.body);
      console.error(`[S3 업로드] 요청 files:`, req.files);
      return res.status(400).json({ 
        error: 'No file uploaded',
        details: '파일이 요청에 포함되지 않았습니다. multipart/form-data 형식으로 "file" 필드에 파일을 첨부해주세요.',
        receivedBody: Object.keys(req.body),
        receivedFiles: req.files ? Object.keys(req.files) : 'none'
      });
    }

    if (!S3_BUCKET_NAME) {
      console.error(`[S3 업로드] S3 버킷이 설정되지 않음`);
      return res.status(500).json({ error: 'S3 bucket not configured' });
    }

    const user_id = req.body.user_id;
    if (!user_id) {
      console.error(`[S3 업로드] user_id가 없음 - 요청 body:`, req.body);
      return res.status(400).json({ 
        error: 'user_id is required',
        details: '요청 body에 user_id를 포함해주세요.',
        receivedBody: req.body
      });
    }

    const quest_id = req.body.quest_id; // quest_id 받기 (선택사항)

    const fileName = req.body.fileName || `${Date.now()}-${req.file.originalname}`;
    const folder = req.body.folder || 'uploads';

    const key = `${folder}/${fileName}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
      // ACL은 버킷 정책으로 관리하는 것이 권장됨
      // ACL: 'public-read' // 일부 리전에서는 ACL이 비활성화될 수 있음
    });

    await s3Client.send(command);

    // S3 URL 생성 (리전별 엔드포인트)
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const fileUrl = `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;

    // 사용자별 업로드 히스토리 저장
    try {
      // 히스토리 저장 (quest_id 포함)
      await pool.execute(
        `INSERT INTO user_upload_history 
         (user_id, quest_id, file_name, file_key, file_url, file_size, content_type) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user_id, quest_id || null, fileName, key, fileUrl, req.file.size, req.file.mimetype]
      );

      console.log(`[업로드 히스토리] user_id: ${user_id}, quest_id: ${quest_id || 'N/A'}, file: ${fileName} 저장 완료`);
    } catch (historyError) {
      // 히스토리 저장 실패해도 업로드는 성공으로 처리
      console.error('[업로드 히스토리 저장 실패]:', historyError.message, historyError.stack);
    }

    // 사진 미션인 경우 user_quest_scores에도 저장
    if (quest_id) {
      try {
        // quest 정보 조회 (사진 미션인지 확인)
        const [questRows] = await pool.execute(
          'SELECT * FROM quests WHERE id = ?',
          [quest_id]
        );

        if (questRows.length > 0) {
          const quest = questRows[0];
          const isPhotoQuest = quest.option_a === '사진 미션';

          if (isPhotoQuest) {
            // 사진 미션인 경우 user_quest_scores에 기록
            // 사진 미션은 완료 시 자동으로 정답 처리 (1점)
            await pool.execute(
              `INSERT INTO user_quest_scores 
               (user_id, quest_id, city, town, village, question, user_answer, correct_answer, score)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE 
                 user_id = user_id`, // 중복 시 업데이트하지 않음
              [
                user_id,
                quest_id,
                quest.city,
                quest.town,
                quest.village,
                quest.question,
                'PHOTO', // 사진 미션 완료 표시
                'A', // 사진 미션은 항상 정답
                1 // 사진 미션 완료 시 1점
              ]
            );

            console.log(`[사진 미션 기록] user_id: ${user_id}, quest_id: ${quest_id} 저장 완료`);
          }
        }
      } catch (scoreError) {
        // 사진 미션 기록 저장 실패해도 업로드는 성공으로 처리
        console.error('[사진 미션 기록 저장 실패]:', scoreError.message, scoreError.stack);
      }
    }

    console.log(`[S3 업로드] 업로드 성공 - user_id: ${user_id}, quest_id: ${quest_id || 'N/A'}, file: ${fileName}, url: ${fileUrl}`);
    
    res.json({
      success: true,
      user_id: user_id,
      quest_id: quest_id || null,
      fileName: fileName,
      key: key,
      url: fileUrl,
      size: req.file.size
    });
  } catch (error) {
    console.error('[S3 업로드] 에러 발생:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code
    });
    res.status(500).json({ 
      error: error.message,
      details: 'S3 업로드 중 오류가 발생했습니다.',
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// 사용자별 업로드 히스토리 조회 (GET /api/s3/upload/history/:user_id)
app.get('/api/s3/upload/history/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT 
        id,
        user_id,
        file_name,
        file_key,
        file_url,
        file_size,
        content_type,
        uploaded_at
       FROM user_upload_history
       WHERE user_id = ?
       ORDER BY uploaded_at DESC`,
      [user_id]
    );

    res.json({
      success: true,
      user_id: user_id,
      count: rows.length,
      history: rows
    });
  } catch (error) {
    console.error('Upload history fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 파일 다운로드 URL 생성 (GET /api/s3/download/:key)
app.get('/api/s3/download/:key(*)', async (req, res) => {
  try {
    const key = req.params.key;

    if (!S3_BUCKET_NAME) {
      return res.status(500).json({ error: 'S3 bucket not configured' });
    }

    // Presigned URL 생성 (임시 다운로드 URL)
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1시간 유효

    res.json({
      url: url,
      expiresIn: 3600
    });
  } catch (error) {
    console.error('S3 download URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 파일 삭제 (DELETE /api/s3/delete/:key)
app.delete('/api/s3/delete/:key(*)', async (req, res) => {
  try {
    const key = req.params.key;

    if (!S3_BUCKET_NAME) {
      return res.status(500).json({ error: 'S3 bucket not configured' });
    }

    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key
    });

    await s3Client.send(command);

    res.json({
      success: true,
      message: 'File deleted successfully',
      key: key
    });
  } catch (error) {
    console.error('S3 delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// S3 uploads 폴더의 파일 목록 조회 (디버깅용)
app.get('/api/s3/debug/uploads', async (req, res) => {
  try {
    if (!S3_BUCKET_NAME) {
      return res.status(500).json({ error: 'S3 bucket not configured' });
    }

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      Prefix: 'uploads/' // uploads 폴더의 모든 파일 조회
    });

    const response = await s3Client.send(command);
    
    const files = (response.Contents || []).map(item => ({
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified,
      urlEncoded: encodeURIComponent(item.Key),
      // 성산으로 시작하는 파일만 필터링
      isSeongsan: item.Key.includes('성산')
    }));

    // 성산으로 시작하는 파일만 필터링
    const seongsanFiles = files.filter(f => f.isSeongsan);

    res.json({
      allFiles: files,
      seongsanFiles: seongsanFiles,
      count: files.length,
      seongsanCount: seongsanFiles.length
    });
  } catch (error) {
    console.error('S3 list error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack 
    });
  }
});

// 업로드 히스토리 테이블 초기화 함수
async function initializeUploadHistoryTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_upload_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL COMMENT '사용자 ID',
        quest_id INT COMMENT '퀘스트 ID (사진 미션인 경우)',
        file_name VARCHAR(255) NOT NULL COMMENT '파일명',
        file_key VARCHAR(500) NOT NULL COMMENT 'S3 파일 키 (경로 포함)',
        file_url TEXT NOT NULL COMMENT 'S3 파일 URL',
        file_size BIGINT NOT NULL COMMENT '파일 크기 (bytes)',
        content_type VARCHAR(100) COMMENT '파일 타입 (MIME type)',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '업로드 시간',
        INDEX idx_user_id (user_id),
        INDEX idx_quest_id (quest_id),
        INDEX idx_uploaded_at (uploaded_at)
      ) COMMENT='사용자별 파일 업로드 히스토리'
    `);
    
    // 기존 테이블에 quest_id 컬럼 추가 (컬럼 존재 여부 확인 후 추가)
    try {
      // 컬럼 존재 여부 확인
      const [columns] = await pool.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'user_upload_history' 
        AND COLUMN_NAME = 'quest_id'
      `);
      
      if (columns.length === 0) {
        // 컬럼이 없으면 추가
        await pool.execute(`
          ALTER TABLE user_upload_history 
          ADD COLUMN quest_id INT COMMENT '퀘스트 ID (사진 미션인 경우)'
        `);
        console.log('[초기화] quest_id 컬럼 추가 완료');
      } else {
        console.log('[초기화] quest_id 컬럼 이미 존재함');
      }
      
      // 인덱스 존재 여부 확인
      const [indexes] = await pool.execute(`
        SELECT INDEX_NAME 
        FROM INFORMATION_SCHEMA.STATISTICS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'user_upload_history' 
        AND INDEX_NAME = 'idx_quest_id'
      `);
      
      if (indexes.length === 0) {
        // 인덱스가 없으면 추가
        await pool.execute(`
          ALTER TABLE user_upload_history 
          ADD INDEX idx_quest_id (quest_id)
        `);
        console.log('[초기화] idx_quest_id 인덱스 추가 완료');
      } else {
        console.log('[초기화] idx_quest_id 인덱스 이미 존재함');
      }
    } catch (alterError) {
      console.warn('[초기화] quest_id 컬럼/인덱스 추가 중 경고:', alterError.message);
    }
    
    console.log('[초기화] user_upload_history 테이블 생성 완료');
  } catch (error) {
    console.error('[초기화] user_upload_history 테이블 생성 실패:', error.message);
  }
}

// 홍길동23 사용자에게 초기 이미지 URL 히스토리 추가
async function initializeHongHistory() {
  try {
    const user_id = '홍길동23';
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const bucket = S3_BUCKET_NAME || 'goormthon-3';
    
    // seongsan0.jpeg, seongsan1.jpeg, seongsan2.jpeg 이미지들
    const images = [
      { fileName: 'seongsan0.jpeg' },
      { fileName: 'seongsan1.jpeg' },
      { fileName: 'seongsan2.jpeg' }
    ];
    
    for (const img of images) {
      const fileKey = `uploads/${img.fileName}`;
      const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${fileKey}`;
      
      try {
        // 중복 체크 후 삽입
        const [existing] = await pool.execute(
          `SELECT id FROM user_upload_history 
           WHERE user_id = ? AND file_key = ?`,
          [user_id, fileKey]
        );
        
        if (existing.length === 0) {
          await pool.execute(
            `INSERT INTO user_upload_history 
             (user_id, file_name, file_key, file_url, file_size, content_type) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [user_id, img.fileName, fileKey, fileUrl, 0, 'image/jpeg']
          );
          console.log(`[초기 히스토리] ${user_id}에 ${img.fileName} 추가 완료`);
        } else {
          console.log(`[초기 히스토리] ${user_id}에 ${img.fileName} 이미 존재함`);
        }
      } catch (error) {
        console.error(`[초기 히스토리] ${img.fileName} 추가 실패:`, error.message);
      }
    }
  } catch (error) {
    console.error('[초기 히스토리] 초기화 실패:', error.message);
  }
}

// 사진 미션 데이터 초기화 함수
async function initializePhotoMissions() {
  try {
    const photoMissions = [
      // City 레벨
      { city: 'Jeju', town: null, village: null, question: '동문시장 등 제주시 일상 풍경이 느껴지는 활기찬 순간을 찍어주세요.' },
      { city: 'Seogwipo', town: null, village: null, question: '폭포와 바다가 함께 보이는 서귀포 특유의 여유로운 풍경을 담아주세요.' },
      // Town 레벨
      { city: 'Jeju', town: 'Aewol', village: null, question: '애월 카페거리에서 바다 감성이 드러나는 장면을 촬영해주세요.' },
      { city: 'Jeju', town: 'Gujwa', village: null, question: '세화 주변에서 청년·예술 분위기가 느껴지는 힙한 공간을 찍어주세요.' },
      { city: 'Seogwipo', town: 'Seogwi', village: null, question: '이중섭 거리에서 예술적 감성이 묻어나는 장소를 사진으로 남겨주세요.' },
      { city: 'Seogwipo', town: 'Seongsan', village: null, question: '성산일출봉이 독특한 각도로 보이는 숨은 포인트를 촬영해주세요.' },
      // Village 레벨
      { city: 'Jeju', town: 'Aewol', village: 'Woljeong', question: '월정리 바다의 청량한 색감이 가장 잘 드러나는 장소를 찍어주세요.' },
      { city: 'Jeju', town: 'Gujwa', village: 'Sehwa', question: '세화오일장 주변에서 로컬의 일상과 예술이 어우러진 순간을 촬영해주세요.' },
      { city: 'Seogwipo', town: 'Seongsan', village: 'Seongsan', question: '성산리 골목 속에서 생활 풍경과 성산일출봉이 함께 보이는 장면을 담아주세요.' }
    ];

    for (const mission of photoMissions) {
      try {
        // 중복 체크 (question과 option_a로 확인)
        const [existing] = await pool.execute(
          `SELECT id FROM quests 
           WHERE city = ? AND COALESCE(town, '') = COALESCE(?, '') 
           AND COALESCE(village, '') = COALESCE(?, '') 
           AND option_a = ? AND question = ?`,
          [mission.city, mission.town || '', mission.village || '', '사진 미션', mission.question]
        );

        if (existing.length === 0) {
          await pool.execute(
            `INSERT INTO quests (city, town, village, question, option_a, option_b, option_c, option_d, correct_answer, score)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [mission.city, mission.town, mission.village, mission.question, '사진 미션', '사진 미션', '사진 미션', '사진 미션', 'A', 1]
          );
          console.log(`[사진 미션 초기화] ${mission.city}${mission.town ? ' ' + mission.town : ''}${mission.village ? ' ' + mission.village : ''} 추가 완료`);
        } else {
          console.log(`[사진 미션 초기화] ${mission.city}${mission.town ? ' ' + mission.town : ''}${mission.village ? ' ' + mission.village : ''} 이미 존재함`);
        }
      } catch (error) {
        console.error(`[사진 미션 초기화] ${mission.city}${mission.town ? ' ' + mission.town : ''}${mission.village ? ' ' + mission.village : ''} 추가 실패:`, error.message);
      }
    }
    console.log('[사진 미션 초기화] 완료');
  } catch (error) {
    console.error('[사진 미션 초기화] 실패:', error.message);
  }
}

// 서버 시작 시 테이블 초기화 및 초기 데이터 삽입
(async () => {
  await initializeUploadHistoryTable();
  await initializeHongHistory();
  await initializePhotoMissions();
  await syncPhotoQuestsToScores();
})();

// 기존 user_upload_history에 있는 사진 미션을 user_quest_scores에 동기화
async function syncPhotoQuestsToScores() {
  try {
    console.log('[초기화] 사진 미션 동기화 시작...');
    
    // user_upload_history에서 quest_id가 있고, 해당 quest가 사진 미션인 경우 조회
    // COLLATE를 명시하여 collation 충돌 방지
    const [uploadHistory] = await pool.execute(
      `SELECT DISTINCT uuh.user_id, uuh.quest_id, uuh.uploaded_at
       FROM user_upload_history uuh
       INNER JOIN quests q ON uuh.quest_id = q.id
       WHERE uuh.quest_id IS NOT NULL 
         AND q.option_a COLLATE utf8mb4_unicode_ci = '사진 미션' COLLATE utf8mb4_unicode_ci
         AND NOT EXISTS (
           SELECT 1 FROM user_quest_scores uqs 
           WHERE uqs.user_id COLLATE utf8mb4_unicode_ci = uuh.user_id COLLATE utf8mb4_unicode_ci
             AND uqs.quest_id = uuh.quest_id
         )
       ORDER BY uuh.uploaded_at DESC`
    );

    console.log(`[초기화] 동기화할 사진 미션 수: ${uploadHistory.length}개`);

    for (const record of uploadHistory) {
      try {
        // quest 정보 조회
        const [questRows] = await pool.execute(
          'SELECT * FROM quests WHERE id = ?',
          [record.quest_id]
        );

        if (questRows.length > 0) {
          const quest = questRows[0];
          
          // user_quest_scores에 기록 (중복 방지)
          await pool.execute(
            `INSERT INTO user_quest_scores 
             (user_id, quest_id, city, town, village, question, user_answer, correct_answer, score, answered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
               user_id = user_id`,
            [
              record.user_id,
              record.quest_id,
              quest.city,
              quest.town,
              quest.village,
              quest.question,
              'PHOTO',
              'A',
              1,
              record.uploaded_at // 업로드 시간을 answered_at으로 사용
            ]
          );

          console.log(`[초기화] 사진 미션 동기화 완료 - user_id: ${record.user_id}, quest_id: ${record.quest_id}`);
        }
      } catch (syncError) {
        console.error(`[초기화] 사진 미션 동기화 실패 - user_id: ${record.user_id}, quest_id: ${record.quest_id}:`, syncError.message);
      }
    }

    console.log(`[초기화] 사진 미션 동기화 완료 - 총 ${uploadHistory.length}개 처리`);
  } catch (error) {
    console.error('[초기화] 사진 미션 동기화 중 오류:', error.message);
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB_HOST: ${process.env.DB_HOST || 'mysql'}`);
  console.log(`DB_NAME: ${process.env.DB_NAME || 'mydb'}`);
  console.log(`S3_BUCKET: ${S3_BUCKET_NAME || 'Not configured'}`);
});

