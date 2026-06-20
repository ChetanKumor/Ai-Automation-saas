#!/usr/bin/env node
// Usage: node scripts/encrypt-token.js <plaintext-wa-token>
// Prints the encrypted string to store in tenants.wa_token
require('dotenv').config();
const { encrypt } = require('../src/utils/encryption');

const token = process.argv[2];
if (!token) {
  console.error('Usage: node scripts/encrypt-token.js <wa-token>');
  process.exit(1);
}

console.log(encrypt(token));
