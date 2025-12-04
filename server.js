const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

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
    const { user_id } = req.params;
    
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
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching user quests:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB_HOST: ${process.env.DB_HOST || 'mysql'}`);
  console.log(`DB_NAME: ${process.env.DB_NAME || 'mydb'}`);
});

