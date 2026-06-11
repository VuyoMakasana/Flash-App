require('dotenv').config();
const { Client } = require('pg');

async function test() {
  const client = new Client({
    host: 'db.ttupbbqbplrhhtuvaaar.supabase.co',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    await client.connect();
    console.log('CONNECTED');
    await client.end();
  } catch (err) {
    console.error(err);
  }
}

test();