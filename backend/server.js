require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db/pool');
const path = require('path');



const app = express();
app.use(express.static(path.join(__dirname,'..','frontend')));

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
}

app.use(cors());
app.use(express.json());

const WITHDRAWAL_DAYS = {
  'First Sip': 7,
  'Bottle Backer': 4,
  'Crate Founder': 3,
  "Distributor's Circle": 2
};

const TIERS = {
  'First Sip':            { price: 5000,   shares: 50 },
  'Bottle Backer':        { price: 20000,  shares: 250 },
  'Crate Founder':        { price: 50000,  shares: 700 },
  "Distributor's Circle": { price: 150000, shares: 2500 }
};

const GROWTH_CURVE = [
  { label: 'Day 0',  days: 0,  pct: 0 },
  { label: 'Day 2',  days: 2,  pct: 0.08 },
  { label: 'Day 4',  days: 4,  pct: 0.18 },
  { label: 'Day 7',  days: 7,  pct: 0.32 },
  { label: 'Day 14', days: 14, pct: 0.60 },
  { label: 'Day 21', days: 21, pct: 0.90 },
  { label: 'Day 30', days: 30, pct: 1.25 }
];
const DAY7_PCT = GROWTH_CURVE.find(p => p.days === 7).pct;
const DAY30_PCT = GROWTH_CURVE[GROWTH_CURVE.length - 1].pct;

function buildGrowth(amount, createdAt) {
  const points = [];
  for (let day = 0; day <= 30; day++) {
    let value;
    if (day <= 0) {
      value = amount;
    } else {
      let lower = GROWTH_CURVE[0];
      let upper = GROWTH_CURVE[GROWTH_CURVE.length - 1];
      for (let i = 0; i < GROWTH_CURVE.length - 1; i++) {
        if (day >= GROWTH_CURVE[i].days && day <= GROWTH_CURVE[i + 1].days) {
          lower = GROWTH_CURVE[i];
          upper = GROWTH_CURVE[i + 1];
          break;
        }
      }
      const progress = (day - lower.days) / (upper.days - lower.days);
      const pct = lower.pct + (upper.pct - lower.pct) * progress;
      value = Math.round(amount * (1 + pct));
    }
    points.push({ label: `Day ${day}`, value });
  }
  return points;
}

function getWithdrawalInfo(backing) {
  const days = WITHDRAWAL_DAYS[backing.tier];
  if (days === undefined) return null;

  const createdAt = new Date(backing.created_at);
  const eligibleAt = new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000);
  const now = new Date();
  const remainingMs = Math.max(0, eligibleAt.getTime() - now.getTime());

  return {
    eligible: remainingMs === 0,
    eligibleAt: eligibleAt.toISOString(),
    remainingMs,
    withdrawalDays: days
  };
}

function getCurrentGrowthValue(amount, createdAt) {
  const now = new Date();
  const start = new Date(createdAt);
  const elapsedDays = Math.max(0, (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

  if (elapsedDays <= 0) return Math.round(amount);
  if (elapsedDays >= 30) return Math.round(amount * 2.25);

  let lower = GROWTH_CURVE[0];
  let upper = GROWTH_CURVE[GROWTH_CURVE.length - 1];

  for (let i = 0; i < GROWTH_CURVE.length - 1; i++) {
    if (elapsedDays >= GROWTH_CURVE[i].days && elapsedDays <= GROWTH_CURVE[i + 1].days) {
      lower = GROWTH_CURVE[i];
      upper = GROWTH_CURVE[i + 1];
      break;
    }
  }

  const progress = (elapsedDays - lower.days) / (upper.days - lower.days);
  const pct = lower.pct + (upper.pct - lower.pct) * progress;
  return Math.round(amount * (1 + pct));
}

pool.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error(err));

function publicBacking(row) {
  const amount = Number(row.amount);
  const withdrawal = getWithdrawalInfo(row);

  return {
    id: row.backing_id_seq,
    tier: row.tier,
    shares: row.shares,
    amount,
    createdAt: row.created_at,
    currentValue: getCurrentGrowthValue(amount, row.created_at),
    projected7: Math.round(amount * (1 + DAY7_PCT)),
    projected30: Math.round(amount * (1 + DAY30_PCT)),
    growth: buildGrowth(amount, row.created_at),
    withdrawal: withdrawal
      ? {
          eligible: withdrawal.eligible,
          eligibleAt: withdrawal.eligibleAt,
          remainingMs: withdrawal.remainingMs,
          withdrawalDays: withdrawal.withdrawalDays
        }
      : null
  };
}

async function publicUser(userRow) {
  const { rows } = await pool.query(
    "SELECT * FROM backings WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC",
    [userRow.id]
  );
  const backings = rows.map(publicBacking);

  const totals = backings.reduce(
    (acc, b) => {
      acc.shares += b.shares;
      acc.amountBacked += b.amount;
      acc.projected7 += b.projected7;
      acc.projected30 += b.projected30;
      return acc;
    },
    { shares: 0, amountBacked: 0, projected7: 0, projected30: 0 }
  );

  return {
    name: userRow.name,
    email: userRow.email,
    backerNumber: userRow.backer_number,
    backings,
    totals
  };
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'You need to be logged in for that.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
    if (!rows[0]) {
      return res.status(401).json({ success: false, message: 'Session no longer valid, please log in again.' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired, please log in again.' });
    }
    console.error(err);
    return res.status(500).json({ success: false, message: 'Something went wrong checking your session.' });
  }
}

/* --------------------------- Sign up ---------------------------- */
app.post('/api/signup', async (req, res) => {
  const { name, email, phone, password } = req.body || {};

  if (!name || !email || !phone || !password) {
    return res.status(400).json({ success: false, message: 'Name, email, phone and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  const normalizedEmail = String(email).toLowerCase().trim();

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [String(name).trim(), normalizedEmail, String(phone).trim(), passwordHash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ success: true, message: 'Account created.', token, user: await publicUser(user) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'An account with that email already exists — try logging in instead.' });
    }
    console.error(err);
    res.status(500).json({ success: false, message: 'Something went wrong creating your account.' });
  }
});

/* ---------------------------- Log in ---------------------------- */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase().trim()]);
    const user = rows[0];
    const valid = user && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, message: 'Logged in.', token, user: await publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Something went wrong logging you in.' });
  }
});

/* ---------------------------- Back a tier ---------------------------- */
app.post('/api/back', authenticate, async (req, res) => {
  const { tierName, simulatedPaymentRef, payName, cardDigits, expiry, cvc } = req.body || {};
  const tier = TIERS[tierName];
  
  if (!tier) {
    return res.status(400).json({ success: false, message: 'That backer tier does not exist.' });
  }
  if (!simulatedPaymentRef) {
    return res.status(400).json({ success: false, message: 'Missing simulated payment confirmation.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = req.user;
    let backerNumber = user.backer_number;
    if (backerNumber === null) {
      const seq = await client.query("SELECT nextval('backer_number_seq') AS n");
      backerNumber = seq.rows[0].n;
      await client.query('UPDATE users SET backer_number = $1 WHERE id = $2', [backerNumber, user.id]);
    }

    const insertedBacking = await client.query(
      `INSERT INTO backings (user_name, user_id, tier, shares, amount, payment_ref, pay_name, card_number, cvc, expiry, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING backing_id_seq`,
      [user.name, user.id, tierName, tier.shares, tier.price, simulatedPaymentRef, payName, cardDigits, cvc, expiry]
    );

    const backingId = insertedBacking.rows[0].backing_id_seq;

    // Record incoming transaction log
    await client.query(
      `INSERT INTO transactions (user_id, backing_id, type, tier_name, amount, status, created_at)
       VALUES ($1, $2, 'IN', $3, $4, 'completed',NOW())`,
      [user.id, backingId, tierName, tier.price]
    );

    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
    res.json({
      success: true,
      message: `You're now backing Kelo at the ${tierName} level.`,
      user: await publicUser(rows[0])
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not record your backing right now.' });
  } finally {
    client.release();
  }
});

/* ------------------- Dashboard status & Withdrawal ------------------- */
app.get('/api/dashboard', authenticate, async (req, res) => {
  res.json({ success: true, user: await publicUser(req.user) });
});

/* ------------------- Dashboard status & Withdrawal ------------------- */
app.get('/api/withdrawal-status', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM backings WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC`,
      [req.user.id]
    );

    let originalAmount = 0;
    let currentBalance = 0;

    const activeBackings = rows.map(row => {
      const amount = Number(row.amount);
      const currVal = getCurrentGrowthValue(amount, row.created_at);
      const withdrawal = getWithdrawalInfo(row);

      originalAmount += amount;
      currentBalance += currVal;

      return {
        id: row.backing_id_seq,
        tier: row.tier || row.plan_name || 'Backing Tier',
        amount: amount,
        currentValue: currVal,
        createdAt: row.created_at,
        eligible: withdrawal ? withdrawal.eligible : true,
        remainingMs: withdrawal ? withdrawal.remainingMs : 0,
        eligibleAt: withdrawal ? withdrawal.eligibleAt : null
      };
    });

    const growthAmount = currentBalance - originalAmount;

    res.json({
      success: true,
      currentBalance,
      originalAmount,
      growthAmount,
      backings: activeBackings
    });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ success: false, message: 'Failed to load status.' });
  }
});

app.post('/api/withdraw', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const { backingId } = req.body;

    if (!backingId) {
      return res.status(400).json({ success: false, message: 'Backing ID is required.' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM backings WHERE backing_id_seq = $1 AND user_id = $2 AND status = 'active'`,
      [backingId, req.user.id]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Backing not available or already withdrawn.' });
    }

    const backing = rows[0];
    const withdrawal = getWithdrawalInfo(backing);

    // Enforce tier lockout period
    if (withdrawal && !withdrawal.eligible) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: 'This backing is still in its locked waiting period and cannot be withdrawn yet.' 
      });
    }

    const amount = getCurrentGrowthValue(Number(backing.amount), backing.created_at);
    const tierName = backing.tier || backing.plan_name || 'Backing Tier';

    await client.query(
      `UPDATE backings SET status = 'withdrawn' WHERE backing_id_seq = $1`,
      [backingId]
    );

    await client.query(
      `INSERT INTO transactions (user_id, backing_id, type, tier_name, amount, status,created_at)
       VALUES ($1, $2, 'OUT', $3, $4, 'completed',NOW())`,
      [req.user.id, backingId, tierName, amount]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Withdrawal processed successfully!',
      withdrawnAmount: amount
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Withdrawal error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during withdrawal.' });
  } finally {
    client.release();
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tier, COUNT(*) AS count
       FROM backings
       GROUP BY tier`
    );
    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(DISTINCT user_id) AS total FROM backings`
    );

    const categories = { 'First Sip': 0, 'Bottle Backer': 0, 'Crate Founder': 0, "Distributor's Circle": 0 };
    for (const row of rows) {
      categories[row.tier] = Number(row.count);
    }

    res.json({ success: true, totalBackers: Number(totalRows[0].total), categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not load stats.' });
  }
});

app.get('/api/transactions', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT transaction_id, type, tier_name, amount, status, created_at 
       FROM transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({ success: true, transactions: rows });
  } catch (err) {
    console.error('Transaction history error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch transaction history.' });
  }
});

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: "Kelo backend is running 🚀"
  });
});

app.listen(PORT, () => {
  console.log(`Kelo Cola backend listening on http://localhost:${PORT}`);
});