const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Only use SSL when explicitly set via DB_SSL=true (e.g. cloud-hosted Postgres)
  // Docker internal network between containers never needs SSL
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error', err);
  process.exit(-1);
});

module.exports = pool;
