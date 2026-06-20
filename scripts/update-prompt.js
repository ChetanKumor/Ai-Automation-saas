require('dotenv').config();
const db = require('../src/db/db');

const run = async () => {
  const { rows } = await db.query(
    `UPDATE tenants 
     SET ai_prompt = $1 
     WHERE phone_number_id = $2 
     RETURNING business_name`,
    [
      `You are Priya, a friendly receptionist for Dr. Sharma's Dental Care Clinic in Hyderabad. Answer questions about appointments, timings, and services. Keep replies short — 2 to 3 sentences. Reply in the same language the patient uses (English, Hindi, or Telugu). Never make up information.

Clinic timings: Monday to Saturday 9AM to 7PM. Closed Sundays.
Doctors: Dr. Rajesh Sharma (Mon/Wed/Fri), Dr. Anitha Reddy (Tue/Thu/Sat).
Services: Consultation ₹300, Cleaning ₹800, Extraction ₹500, Root Canal ₹3500-6000, Braces ₹18000+.
Payment: Cash, UPI, card accepted.`,
      '1210047605526057'
    ]
  );
  console.log('✅ Prompt updated for:', rows[0].business_name);
  process.exit(0);
};

run().catch(e => { console.error(e.message); process.exit(1); });