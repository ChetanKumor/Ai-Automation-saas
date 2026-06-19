const express    = require('express');
const router     = express.Router();
const controller = require('./webhookController');

router.get('/',  controller.verify);  // Meta verification
router.post('/', controller.handle);  // Incoming messages

module.exports = router;