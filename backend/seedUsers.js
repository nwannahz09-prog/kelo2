require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./db/pool');

async function seedUsers() {
  try {
    // Password used by all test accounts
    const passwordHash = await bcrypt.hash('password123', 10);

    // Create 1,000 synthetic users
    for (let i = 1; i <= 1061; i++) {
      const name = `Test User ${i}`;
      const email = `testuser${i}@gmail.com`;
      const phone = `080${String(i).padStart(8, '0')}`;

      await pool.query(
        `INSERT INTO users
          (name, email, phone, password_hash)
         VALUES
          ($1, $2, $3, $4)`,
        [
          name,
          email,
          phone,
          passwordHash
        ]
      );
    }

    console.log('Successfully created 1,000+ test users.');

  } catch (error) {
    console.error('Error creating test users:', error);
  } finally {
    await pool.end();
  }
}

seedUsers();