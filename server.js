const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

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
// 실제 S3에 저장된 파일명을 사용하여 정확한 URL 생성
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
    // 실제 S3에 저장된 파일 목록에서 정확한 파일명 가져오기
    const files = await getSeongsanImageList();
    console.log(`[getSeongsanImageUrl] Found ${files.length} files for index ${index}:`, files);
    
    // index에 해당하는 파일 찾기
    if (index >= files.length) {
      console.warn(`[getSeongsanImageUrl] Index ${index} is out of range (files.length: ${files.length})`);
      return null;
    }
    
    const actualKey = files[index];
    console.log(`[getSeongsanImageUrl] Using actual S3 key for index ${index}: ${actualKey}`);
    
    // Presigned URL 생성 (1시간 유효)
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: actualKey
    });
    
    const url = await getSignedUrl(s3Client, command, { 
      expiresIn: 3600 // 1시간
    });
    
    console.log(`[getSeongsanImageUrl] Successfully generated Presigned URL for index ${index}`);
    return url;
  } catch (error) {
    console.error(`[getSeongsanImageUrl] Error for index ${index}:`, error.message, error.stack);
    return null;
  }
}

// Multer 설정 (메모리 스토리지 - 파일을 메모리에 저장)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB 제한
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

// 지역별 랜덤 퀘스트 문제 조회
app.get('/api/quests/random', async (req, res) => {
  try {
    // Express는 쿼리 파라미터를 자동으로 디코딩하지만,
    // 일부 프록시/인그레스에서 이중 인코딩이 될 수 있으므로 안전하게 처리
    // 원본 쿼리 문자열에서 직접 파싱하는 방법도 고려 가능
    let city = req.query.city;
    let town = req.query.town;
    let village = req.query.village;
    
    // %가 포함되어 있으면 아직 인코딩된 상태이므로 디코딩 시도
    // Express가 이미 디코딩했다면 %가 없을 것이므로 이 조건은 통과하지 않음
    if (city && typeof city === 'string' && city.includes('%')) {
      try {
        city = decodeURIComponent(city);
      } catch (e) {
        // 디코딩 실패 시 원본 사용
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
    
    // 디버깅을 위해 로그 추가
    console.log('Quest search params (raw):', req.query);
    console.log('Quest search params (processed):', { city, town, village });
    
    // 지역별 랜덤 문제 1개 조회
    let query = 'SELECT * FROM quests WHERE city = ?';
    let params = [city];
    
    if (town) {
      query += ' AND town = ?';
      params.push(town);
    }
    
    if (village) {
      query += ' AND village = ?';
      params.push(village);
    }
    
    query += ' ORDER BY RAND() LIMIT 1';
    
    console.log('Executing query:', query, 'with params:', params);
    
    const [rows] = await pool.execute(query, params);
    
    console.log('Query result count:', rows.length);
    
    if (rows.length === 0) {
      // 사용 가능한 city 목록 조회해서 힌트 제공
      const [availableCities] = await pool.execute('SELECT DISTINCT city FROM quests');
      return res.status(404).json({ 
        error: `No quest found for region: ${city}${town ? ' ' + town : ''}${village ? ' ' + village : ''}`,
        availableCities: availableCities.map(r => r.city),
        receivedParams: { city, town, village }
      });
    }
    
    const quest = rows[0];
    
    // 정답을 제외하고 반환 (정답은 별도 엔드포인트에서 확인)
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
      score: quest.score  // 문제 점수 정보 포함
    });
  } catch (error) {
    console.error('Error fetching random quest:', error);
    res.status(500).json({ error: error.message });
  }
});

// 퀘스트 정답 확인 및 점수 기록
app.post('/api/quests/:id/check', async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, user_id } = req.body; // user_id는 user_id 필드 (예: "지현23")
    
    // 파라미터 검증
    if (!answer) {
      return res.status(400).json({ error: 'Answer is required' });
    }
    
    if (!id) {
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
    
    // 사용자 ID가 제공된 경우 풀이 기록 저장 (한 번 기록되면 변경되지 않음)
    if (user_id) {
      try {
        // 풀이 기록 저장 (ON DUPLICATE KEY UPDATE로 중복 방지, 한 번 기록되면 변경 안 됨)
        await pool.execute(
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
      } catch (scoreError) {
        console.error('Error saving quest record:', scoreError);
        // 기록 저장 실패해도 정답 확인은 진행
      }
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
    
    const [rows] = await pool.execute(
      `SELECT 
        id,
        user_id,
        quest_id,
        answered_at as '문제 푼 시간',
        city as '시',
        town as '동',
        village as '리',
        question as '푼 문제',
        user_answer as '사용자가 제출한 정답',
        correct_answer as '실제 정답',
        score as '점수'
       FROM user_quest_scores
       WHERE user_id = ?
       ORDER BY answered_at DESC`,
      [user_id]
    );
    
    console.log(`[퀘스트 조회] 조회된 퀘스트 수: ${rows.length}개`);
    
    // 지역명을 한국어로 변환하고 이미지 URL 추가
    // 성산0.jpeg, 성산1.jpeg, 성산2.jpeg만 순서대로 불러오기
    const translatedRows = await Promise.all(
      rows.map(async (row, index) => {
        // questId와 관계없이 순서대로 성산0, 성산1, 성산2 이미지 불러오기
        const imageUrl = await getSeongsanImageUrl(index);
        
        console.log(`[퀘스트 조회] index ${index}, quest_id ${row.quest_id}, 이미지 URL: ${imageUrl ? '생성됨' : '없음'}`);
        
        return {
          ...row,
          '시': translateRegionName(row['시'], 'city'),
          '동': row['동'] ? translateRegionName(row['동'], 'town') : row['동'],
          '리': row['리'] ? translateRegionName(row['리'], 'village') : row['리'],
          '이미지 URL': imageUrl || null
        };
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

// 파일 업로드 (POST /api/s3/upload)
app.post('/api/s3/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!S3_BUCKET_NAME) {
      return res.status(500).json({ error: 'S3 bucket not configured' });
    }

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

    res.json({
      success: true,
      fileName: fileName,
      key: key,
      url: fileUrl,
      size: req.file.size
    });
  } catch (error) {
    console.error('S3 upload error:', error);
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB_HOST: ${process.env.DB_HOST || 'mysql'}`);
  console.log(`DB_NAME: ${process.env.DB_NAME || 'mydb'}`);
  console.log(`S3_BUCKET: ${S3_BUCKET_NAME || 'Not configured'}`);
});

