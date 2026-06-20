const express    = require('express');
const crypto     = require('crypto');
const router     = express.Router();
const controller = require('./webhookController');

function verifySignature(req, res, next) {
  try {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return res.sendStatus(401);

    const expected = 'sha256=' +
      crypto.createHmac('sha256', process.env.META_APP_SECRET)
        .update(req.body)       // req.body is a raw Buffer here
        .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.sendStatus(401);
    }

    // Parse raw buffer to JSON so the controller sees a normal object
    req.body = JSON.parse(req.body);
    next();
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    res.sendStatus(500);
  }
}

router.get('/',  controller.verify);                       // Meta verification (no signature)
router.post('/', verifySignature, controller.handle);      // Incoming messages

module.exports = router;