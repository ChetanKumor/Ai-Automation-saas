'use strict';

const EVENT = Object.freeze({
  CUSTOMER_CREATED:    'customer.created',
  CUSTOMER_IDENTIFIED: 'customer.identified',
  MESSAGE_RECEIVED:    'message.received',
  CALL_STARTED:        'call.started',
  CALL_ENDED:          'call.ended',
});

module.exports = EVENT;
