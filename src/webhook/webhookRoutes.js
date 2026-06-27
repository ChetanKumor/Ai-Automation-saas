const express    = require('express');
const crypto     = require('crypto');
const router     = express.Router();
const controller = require('./webhookController');

function verifySignature(req, res, next) {
  try {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      console.warn('[Webhook] Rejected: missing signature header');
      return res.sendStatus(401);
    }

    const expected = 'sha256=' +
      crypto.createHmac('sha256', process.env.META_APP_SECRET)
        .update(req.body)       // req.body is a raw Buffer here
        .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      console.warn('[Webhook] Rejected: invalid signature');
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
module.exports._verifySignature = verifySignature;