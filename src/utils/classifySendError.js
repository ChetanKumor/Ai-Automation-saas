const REENGAGEMENT_CODE = 131047;

function classifySendError(err) {
  if (err.code === 'ECONNABORTED') return 'timeout';

  const status = err.response?.status;
  if (status) {
    if (status === 429) return 'retryable';
    if (status >= 500) return 'retryable';
    const metaCode = err.response?.data?.error?.code;
    if (metaCode === REENGAGEMENT_CODE) return 'needs_template';
    return 'non_retryable';
  }

  if (err.request) return 'retryable';
  return 'non_retryable';
}

module.exports = { classifySendError };
